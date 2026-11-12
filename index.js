/**
 * Host half of the live subtitle plugin.
 *
 * It owns the system-audio capture/recognition process, translates draft and final
 * lines through the Harness translator (with the configured native model as a
 * fallback), and exposes a small same-origin HTTP/SSE surface for the Web panel.
 * The Python engine runs faster-whisper locally: tiny windows produce live drafts,
 * while a pause produces a final line from the more accurate base model.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createInterface } from 'node:readline'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE = path.join(HERE, 'engine', 'engine.py')
const ROUTE = '/api/realtime-subtitles'
const PROVIDER_ID = 'sensevoice-local'
const TARGET_LANGUAGE = 'zh-CN'
const MAX_SEGMENTS = 80
const MAX_QUEUE = 8

export const name = 'realtime-subtitles'
export const inject = ['webServer', 'speechToText']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function cleanTranscript(raw, language) {
  let text = typeof raw === 'string' ? raw : raw?.text ?? ''
  text = String(text)
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (language === 'ja') {
    // SenseVoice emits token-separated Japanese. Join kana/kanji runs while
    // keeping spaces around Latin words and numbers.
    text = text
      .replace(/(?<=[\u3040-\u30ff\u3400-\u9fff])\s+(?=[\u3040-\u30ff\u3400-\u9fff])/g, '')
      .replace(/\s+([、。，．！？）」』】])/g, '$1')
      .replace(/([「『【（])\s+/g, '$1')
  }
  return text.trim()
}

function timestamp() {
  return Date.now()
}

export function apply(ctx, config = {}) {
  const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'DSHRealtimeSubtitles')
  let logFile = null
  try {
    mkdirSync(logDir, { recursive: true })
    logFile = path.join(logDir, 'plugin.log')
  } catch {
    logFile = null
  }

  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`
    try {
      console.log(`[realtime-subtitles] ${message}`)
    } catch {
      // ignore
    }
    if (logFile) {
      try {
        appendFileSync(logFile, `${line}\n`)
      } catch {
        // ignore
      }
    }
  }

  const clients = new Set()
  let stateTimer = null
  let child = null
  let childGeneration = 0
  let lifetime = new AbortController()
  let starting = false
  let stopping = false
  let pythonPath = ''
  let depsChecked = false
  let transcribing = false
  let finalTranslationSlots = 0
  let partialTranslationSlots = 0
  const transcriptionQueue = []
  const translationCache = new Map()
  const partialJobs = new Map()

  const state = {
    running: false,
    phase: 'idle',
    message: '',
    error: null,
    sourceLanguage: ['ja', 'en', 'auto'].includes(config.sourceLanguage) ? config.sourceLanguage : 'ja',
    targetLanguage: TARGET_LANGUAGE,
    overlayVisible: config.overlay !== false,
    fontSize: clampNumber(config.fontSize, 18, 52, 30),
    position: config.position === 'top' ? 'top' : 'bottom',
    opacity: 0.9,
    model: 'Whisper tiny drafts + base finals',
    asrDevice: 'cpu',
    prepared: false,
    preparation: null,
    level: 0,
    speaking: false,
    pending: null,
    segments: [],
    lastFinalSegment: -1,
    device: '',
    vad: '',
    startedAt: null,
    python: '',
    updatedAt: timestamp(),
  }

  function snapshot() {
    return {
      ...state,
      segments: state.segments.slice(),
      preparation: state.preparation ? { ...state.preparation } : null,
      pending: state.pending ? { ...state.pending } : null,
    }
  }

  function broadcast(type, payload) {
    const frame = `data: ${JSON.stringify({ type, ...payload })}\n\n`
    for (const response of clients) {
      try {
        response.write(frame)
      } catch {
        clients.delete(response)
      }
    }
  }

  function scheduleState() {
    state.updatedAt = timestamp()
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      broadcast('state', { state: snapshot() })
    }, 70)
  }

  function setPhase(phase, message = '') {
    state.phase = phase
    state.message = message
    if (phase !== 'error') state.error = null
    scheduleState()
  }

  function setError(error, message = '') {
    const text = error instanceof Error ? error.message : String(error ?? '')
    state.phase = 'error'
    state.error = text || message || '未知错误'
    state.message = message
    log(`error: ${state.error}`)
    scheduleState()
  }

  // ------------------------------------------------------------------ HTTP/SSE
  function json(response, status, value) {
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          reject(new Error('请求体过大'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('请求格式无效'))
        }
      })
      request.on('error', reject)
    })
  }

  async function handle(request, response) {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const sub = url.pathname.slice(ROUTE.length) || '/'
    if (request.method === 'GET' && sub === '/state') {
      return json(response, 200, snapshot())
    }
    if (request.method === 'GET' && sub === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.write('retry: 1500\n\n')
      response.write(`data: ${JSON.stringify({ type: 'state', state: snapshot() })}\n\n`)
      clients.add(response)
      request.on('close', () => clients.delete(response))
      return
    }
    if (request.method === 'POST' && sub === '/start') {
      const body = await readJson(request)
      const language = body.sourceLanguage ?? body.language
      if (!['ja', 'en', 'auto'].includes(language)) throw new Error('不支持的源语言')
      state.sourceLanguage = language
      state.overlayVisible = body.overlayVisible !== false
      if (body.fontSize !== undefined) state.fontSize = clampNumber(body.fontSize, 18, 52, 30)
      if (body.position === 'top' || body.position === 'bottom') state.position = body.position
      if (state.running || starting) return json(response, 200, snapshot())
      start().catch((error) => {
        log(`background start failed: ${error instanceof Error ? error.message : String(error)}`)
        setError(error, '启动失败')
      })
      return json(response, 200, snapshot())
    }
    if (request.method === 'POST' && sub === '/stop') {
      await stop('user')
      return json(response, 200, snapshot())
    }
    if (request.method === 'POST' && sub === '/overlay') {
      const body = await readJson(request)
      if (typeof body.visible === 'boolean') state.overlayVisible = body.visible
      if (body.fontSize !== undefined) state.fontSize = clampNumber(body.fontSize, 18, 52, 30)
      if (body.position === 'top' || body.position === 'bottom') state.position = body.position
      if (body.opacity !== undefined) state.opacity = clampNumber(body.opacity, 0.3, 1, 0.9)
      const last = state.segments.length > 0 ? state.segments[state.segments.length - 1] : null
      sendEngine({
        cmd: 'overlay',
        visible: state.overlayVisible,
        fontSize: state.fontSize,
        position: state.position,
        opacity: state.opacity,
        text: state.overlayVisible && last ? last.translation || last.source : '',
        source: state.overlayVisible && last ? last.source : '',
      })
      if (!state.overlayVisible) sendEngine({ cmd: 'hide' })
      scheduleState()
      return json(response, 200, snapshot())
    }
    if (request.method === 'POST' && sub === '/clear') {
      state.segments = []
      state.pending = null
      scheduleState()
      return json(response, 200, snapshot())
    }
    if (request.method === 'GET' && sub === '/devices') {
      return json(response, 200, { devices: [] })
    }
    return json(response, 404, { error: 'not-found' })
  }

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (request, response) => {
      handle(request, response).catch((error) => {
        try {
          json(response, 500, { error: error instanceof Error ? error.message : String(error) })
        } catch {
          // response already settled
        }
      })
    },
  })

  // ------------------------------------------------------------------ Python
  function findPython() {
    if (pythonPath) return pythonPath
    if (config.pythonPath && existsSync(config.pythonPath)) return (pythonPath = config.pythonPath)
    const candidates = []
    if (process.env.DSH_REALTIME_PYTHON) candidates.push(process.env.DSH_REALTIME_PYTHON)
    candidates.push(
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
      'D:\\Environment\\anaconda\\python.exe',
      'C:\\ProgramData\\anaconda3\\python.exe',
      'C:\\Python311\\python.exe',
      'C:\\Python312\\python.exe',
      'python',
    )
    for (const candidate of candidates) {
      if (!candidate) continue
      if (candidate === 'python') {
        pythonPath = 'python'
        return pythonPath
      }
      if (existsSync(candidate)) {
        pythonPath = candidate
        return pythonPath
      }
    }
    pythonPath = 'python'
    return pythonPath
  }

  function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const ps = spawn(command, args, {
        windowsHide: true,
        cwd: HERE,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        ...options,
      })
      let stdout = ''
      let stderr = ''
      ps.stdout?.on('data', (chunk) => {
        if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8')
      })
      ps.stderr?.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
      })
      ps.on('error', reject)
      ps.on('close', (code) => {
        resolve({ code, stdout, stderr, elapsed: Date.now() - started })
      })
      if (options.timeout) {
        setTimeout(() => {
          try {
            ps.kill()
          } catch {
            // ignore
          }
        }, options.timeout)
      }
    })
  }

  async function ensurePythonDependencies() {
    if (depsChecked) return
    const python = findPython()
    setPhase('preparing', '正在检查 Python 音频与识别组件…')
    const check = await run(
      python,
      ['-c', 'import soundcard, numpy, faster_whisper, ctranslate2; assert ctranslate2.__version__.startswith("4.5"); print("ok")'],
      { timeout: 30_000 },
    )
    if (check.code === 0) {
      depsChecked = true
      return
    }
    log(`python dependency check failed: ${check.stderr || check.stdout}`)
    setPhase('preparing', '正在安装 Python 音频与识别组件（首次约 1–2 分钟）…')
    const install = await run(
      python,
      [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--user',
        'soundcard',
        'faster-whisper==1.2.1',
        'ctranslate2==4.5.0',
      ],
      { timeout: 600_000 },
    )
    if (install.code !== 0) {
      throw new Error(`无法安装语音识别组件：${(install.stderr || install.stdout).slice(-800)}`)
    }
    const recheck = await run(
      python,
      ['-c', 'import soundcard, numpy, faster_whisper, ctranslate2; assert ctranslate2.__version__.startswith("4.5"); print("ok")'],
      { timeout: 30_000 },
    )
    if (recheck.code !== 0) throw new Error('语音识别组件安装后仍无法导入 faster-whisper / ctranslate2 4.5')
    depsChecked = true
  }

  function asrModelDirectory(size) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'realtime-subtitles', 'faster-whisper', size)
  }

  async function prepareSpeech() {
    const stt = ctx.speechToText
    const provider = stt.listProviders().find((item) => item.id === PROVIDER_ID)
    if (!provider) throw new Error('本地语音识别服务未启用（sensevoice-local）')
    state.model = provider.name || 'SenseVoiceSmall'
    const phase = provider.preparation?.phase
    if (phase === 'ready' || phase === 'standby') {
      state.prepared = true
      state.preparation = provider.preparation ?? null
      return
    }

    setPhase('preparing', '首次使用需要下载本地语音模型（约 239 MB）…')
    try {
      stt.prepare(PROVIDER_ID)
    } catch (error) {
      if (!/already|prepar/i.test(String(error?.message))) throw error
    }

    const deadline = Date.now() + 20 * 60 * 1000
    let lastPhase = ''
    while (Date.now() < deadline) {
      if (lifetime.signal.aborted) throw new Error('已取消')
      const current = stt.snapshot().providers.find((item) => item.id === PROVIDER_ID)
      const prep = current?.preparation ?? null
      state.preparation = prep
      if (prep?.phase && prep.phase !== lastPhase) {
        lastPhase = prep.phase
        log(`speech preparation: ${prep.phase}`)
      }
      if (prep?.phase === 'ready' || prep?.phase === 'standby') {
        state.prepared = true
        scheduleState()
        return
      }
      if (prep?.phase === 'failed' || prep?.phase === 'cancelled') {
        throw new Error(prep.message || '本地语音模型准备失败')
      }
      if (prep?.phase === 'downloading' && prep.totalBytes) {
        const percent = Math.round((prep.completedBytes / prep.totalBytes) * 100)
        state.message = `正在下载 ${prep.resource || '语音模型'}… ${percent}%`
      } else if (prep?.phase === 'verifying') {
        state.message = '正在校验语音模型…'
      } else if (prep?.phase === 'loading') {
        state.message = '正在加载语音模型…'
      }
      scheduleState()
      await sleep(500)
    }
    throw new Error('本地语音模型准备超时')
  }

  function sendEngine(payload) {
    if (!child || !child.stdin?.writable) return false
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch {
      return false
    }
  }

  function attachEngine(instance, generation) {
    const stdout = createInterface({ input: instance.stdout })
    stdout.on('line', (line) => {
      if (generation !== childGeneration) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      handleEngineEvent(event).catch((error) => setError(error))
    })
    instance.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text) log(`engine: ${text.slice(0, 2000)}`)
    })
    instance.on('error', (error) => {
      if (generation === childGeneration) setError(error, '音频引擎启动失败')
    })
    instance.on('exit', (code) => {
      if (generation !== childGeneration) return
      child = null
      if (state.running && !stopping) {
        setError(new Error(`音频引擎已退出（代码 ${code}）`))
        state.running = false
      }
      scheduleState()
    })
  }

  async function handleEngineEvent(event) {
    switch (event.type) {
      case 'ready':
        state.device = event.device || ''
        state.vad = event.vad || ''
        state.python = event.python || ''
        state.asrDevice = event.asrDevice || ''
        if (event.asr === 'faster-whisper') state.model = 'Whisper tiny drafts + base finals'
        state.running = true
        state.startedAt = state.startedAt || timestamp()
        setPhase('listening', '')
        sendEngine({
          cmd: 'overlay',
          visible: state.overlayVisible,
          fontSize: state.fontSize,
          position: state.position,
          opacity: state.opacity,
        })
        break
      case 'audio-device':
        state.device = event.name || state.device
        scheduleState()
        break
      case 'level':
        state.level = clampNumber(event.level, 0, 1, 0)
        broadcast('level', { level: state.level })
        break
      case 'speech':
        state.speaking = Boolean(event.speaking)
        scheduleState()
        break
      case 'asr-prepare': {
        state.phase = 'preparing'
        state.message = event.message || '正在准备本地 Whisper 模型…'
        state.preparation = {
          phase: event.phase || 'checking',
          resource: event.resource,
          completedBytes: event.completedBytes,
          totalBytes: event.totalBytes,
          message: event.message,
        }
        scheduleState()
        break
      }
      case 'transcript': {
        const text = cleanTranscript(event.text, event.language || state.sourceLanguage)
        if (event.final) {
          log(`asr-local seg=${event.segmentId} final audio=${event.durationMs ?? 0}ms asr=${event.asrMs ?? 0}ms chars=${text.length}`)
          await acceptFinal(event, text)
        } else {
          if (text) log(`asr-local seg=${event.segmentId} draft asr=${event.asrMs ?? 0}ms chars=${text.length}`)
          acceptPartial(event, text)
        }
        break
      }
      case 'asr-error':
        state.running = false
        setError(new Error(event.message || '本地语音识别失败'), '语音识别不可用')
        try {
          child?.kill()
        } catch {
          // ignore
        }
        break
      case 'chunk':
        enqueueChunk(event)
        break
      case 'overlay-error':
        state.overlayVisible = false
        state.error = event.message ? `桌面悬浮字幕不可用：${event.message}` : '桌面悬浮字幕不可用'
        scheduleState()
        break
      case 'error':
        state.running = false
        setError(new Error(event.message || '音频采集失败'))
        try {
          child?.kill()
        } catch {
          // ignore
        }
        break
      default:
        break
    }
  }

  function enqueueChunk(chunk) {
    if (chunk.final) {
      // A final result is more valuable than any draft. Drop queued drafts and
      // place the final after other finals so segment order stays intact.
      for (let index = transcriptionQueue.length - 1; index >= 0; index -= 1) {
        if (!transcriptionQueue[index].final) transcriptionQueue.splice(index, 1)
      }
      transcriptionQueue.push(chunk)
    } else {
      // Keep at most one queued draft, and only the newest one for this stretch
      // of speech. Drafts must never delay a final recognition.
      for (let index = transcriptionQueue.length - 1; index >= 0; index -= 1) {
        const item = transcriptionQueue[index]
        if (!item.final && item.segmentId <= chunk.segmentId) transcriptionQueue.splice(index, 1)
      }
      transcriptionQueue.push(chunk)
    }
    while (transcriptionQueue.length > MAX_QUEUE) {
      const draftIndex = transcriptionQueue.findIndex((item) => !item.final)
      if (draftIndex >= 0) transcriptionQueue.splice(draftIndex, 1)
      else transcriptionQueue.shift()
    }
    drainTranscription()
  }

  async function drainTranscription() {
    if (transcribing) return
    transcribing = true
    try {
      while (transcriptionQueue.length > 0) {
        const chunk = transcriptionQueue.shift()
        if (lifetime.signal.aborted) continue
        if (chunk.final && chunk.segmentId < state.lastFinalSegment) continue
        if (!chunk.final && chunk.segmentId < state.lastFinalSegment) continue
        try {
          const startedAt = Date.now()
          const transcript = await transcribe(chunk)
          if (lifetime.signal.aborted) continue
          if (chunk.final) {
            log(
              `asr seg=${chunk.segmentId} final audio=${chunk.durationMs ?? 0}ms ` +
                `took=${Date.now() - startedAt}ms chars=${transcript.length}`,
            )
            await acceptFinal(chunk, transcript)
          } else {
            acceptPartial(chunk, transcript)
          }
        } catch (error) {
          if (!lifetime.signal.aborted) {
            log(`transcription failed: ${error instanceof Error ? error.message : String(error)}`)
            state.error = error instanceof Error ? error.message : String(error)
            scheduleState()
          }
        }
      }
    } finally {
      transcribing = false
      if (transcriptionQueue.length > 0) drainTranscription()
    }
  }

  async function transcribe(chunk) {
    const audio = Buffer.from(chunk.audio, 'base64')
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
    const spec = ctx.speechToText.resolve({
      audio: bytes,
      language: chunk.language || state.sourceLanguage,
      providerId: PROVIDER_ID,
    })
    const result = await ctx.speechToText.transcribe(spec, lifetime.signal)
    return cleanTranscript(result, chunk.language || state.sourceLanguage)
  }

  function acceptPartial(chunk, transcript) {
    if (!transcript) return
    if (chunk.segmentId < state.lastFinalSegment) return
    const previous = state.pending && state.pending.segmentId === chunk.segmentId ? state.pending : null
    state.pending = {
      segmentId: chunk.segmentId,
      source: transcript,
      translation: previous?.translation || '',
      at: timestamp(),
    }
    scheduleState()
    requestPartialTranslation(chunk.segmentId, transcript)
  }

  async function acceptFinal(chunk, transcript) {
    const previous = state.pending && state.pending.segmentId === chunk.segmentId ? state.pending : null
    state.pending = null
    partialJobs.delete(chunk.segmentId)
    if (!transcript) {
      if (previous) state.pending = previous
      scheduleState()
      return
    }
    state.lastFinalSegment = Math.max(state.lastFinalSegment ?? -1, chunk.segmentId)
    const segment = {
      id: `${chunk.segmentId}-${Date.now()}`,
      segmentId: chunk.segmentId,
      source: transcript,
      translation: '',
      status: 'translating',
      at: timestamp(),
      durationMs: chunk.durationMs ?? 0,
    }
    state.segments.push(segment)
    if (state.segments.length > MAX_SEGMENTS) state.segments.splice(0, state.segments.length - MAX_SEGMENTS)
    scheduleState()
    translateSegment(segment).catch((error) => {
      segment.status = 'error'
      segment.translation = segment.source
      segment.error = error instanceof Error ? error.message : String(error)
      scheduleState()
    })
  }

  // ------------------------------------------------------------------ draft translation
  function requestPartialTranslation(segmentId, text) {
    if (segmentId <= state.lastFinalSegment) return
    let job = partialJobs.get(segmentId)
    if (!job) {
      job = {
        id: segmentId,
        latestText: '',
        lastText: '',
        lastTranslation: '',
        inFlight: false,
      }
      partialJobs.set(segmentId, job)
    }
    job.latestText = text
    pumpPartialTranslation(job)
  }

  function pumpPartialTranslation(job) {
    if (job.inFlight || partialTranslationSlots >= 1) return
    if (job.id <= state.lastFinalSegment) {
      partialJobs.delete(job.id)
      return
    }
    if (!job.latestText || job.latestText === job.lastText) return
    job.inFlight = true
    partialTranslationSlots += 1
    const text = job.latestText
    job.lastText = text
    const startedAt = Date.now()
    translateText(text, state.sourceLanguage, { timeout: 3500 })
      .then((translated) => {
        if (lifetime.signal.aborted || job.id <= state.lastFinalSegment) return
        if (!translated) return
        job.lastTranslation = translated
        const currentTranslation = state.pending?.segmentId === job.id ? state.pending.translation || '' : ''
        // Keep the draft growing instead of flickering between shorter and longer
        // guesses from the tiny model.  The final base-model translation replaces it.
        if (translated.length < currentTranslation.length) return
        if (state.pending?.segmentId === job.id) {
          state.pending = { ...state.pending, translation: translated, at: timestamp() }
          scheduleState()
        }
        sendEngine({ cmd: 'subtitle', translation: translated, source: text, partial: true })
        log(`draft seg=${job.id} input=${text.length} took=${Date.now() - startedAt}ms`)
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) {
          log(`draft translation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      .finally(() => {
        job.inFlight = false
        partialTranslationSlots -= 1
        if (job.id > state.lastFinalSegment && job.latestText !== text) {
          pumpPartialTranslation(job)
          return
        }
        // A draft for another segment may have been waiting for the only slot.
        for (const candidate of partialJobs.values()) {
          if (candidate.id > state.lastFinalSegment && !candidate.inFlight && candidate.latestText !== candidate.lastText) {
            pumpPartialTranslation(candidate)
            break
          }
        }
      })
  }

  // ------------------------------------------------------------------ translation
  async function translateSegment(segment) {
    while (finalTranslationSlots >= 2) await sleep(40)
    finalTranslationSlots += 1
    try {
      const startedAt = Date.now()
      const translated = await translateText(segment.source, state.sourceLanguage, { timeout: 12000 })
      const text = translated || segment.source
      segment.translation = text
      segment.status = translated ? 'done' : 'source'
      scheduleState()
      sendEngine({
        cmd: 'subtitle',
        translation: text,
        source: segment.source,
      })
      log(`translated seg=${segment.segmentId} took=${Date.now() - startedAt}ms chars=${text.length}`)
    } finally {
      finalTranslationSlots -= 1
    }
  }

  async function translateText(text, sourceLanguage, options = {}) {
    const key = `${sourceLanguage}\u0000${text}`
    if (translationCache.has(key)) return translationCache.get(key)
    const source = sourceLanguage === 'auto' ? undefined : sourceLanguage
    const timeout = options.timeout ?? 12_000

    const translator = ctx.get('translator')
    if (translator) {
      for (const provider of ['bing', 'google']) {
        try {
          const spec = translator.resolve({
            text,
            targetLanguage: TARGET_LANGUAGE,
            ...(source ? { sourceLanguage: source } : {}),
            provider,
          })
          const providerTimeout = provider === 'google' ? Math.min(4_500, timeout) : timeout
          const result = await translator.translate(spec, AbortSignal.timeout(providerTimeout))
          const value = String(result ?? '').trim()
          if (value) {
            rememberTranslation(key, value)
            return value
          }
        } catch (error) {
          log(`translator ${provider} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const fallback = await llmTranslate(text, source)
    if (fallback) {
      rememberTranslation(key, fallback)
      return fallback
    }
    return ''
  }

  function rememberTranslation(key, value) {
    if (translationCache.size > 500) translationCache.clear()
    translationCache.set(key, value)
  }

  async function llmTranslate(text, sourceLanguage) {
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!llm || !selection?.provider || !selection?.model) return ''
    try {
      let output = ''
      const stream = llm.stream({
        provider: selection.provider,
        model: selection.model,
        temperature: 0,
        maxTokens: 512,
        messages: [
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text:
                  'You translate live video subtitles into Simplified Chinese. Return only the translation, ' +
                  'without quotes, explanations or speaker labels. Keep the tone natural and concise.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${sourceLanguage === 'ja' ? 'Japanese' : sourceLanguage === 'en' ? 'English' : 'The source language'} subtitle:\n${text}`,
              },
            ],
          },
        ],
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.kind !== 'stop' && chunk.kind !== undefined) {
          throw new Error(chunk.failure?.message || `翻译模型结束：${chunk.kind}`)
        }
      }
      return output.trim()
    } catch (error) {
      log(`llm translation failed: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  // ------------------------------------------------------------------ lifecycle
  async function start() {
    if (starting || state.running) return
    starting = true
    stopping = false
    lifetime = new AbortController()
    transcriptionQueue.length = 0
    state.segments = []
    state.pending = null
    state.level = 0
    state.speaking = false
    state.error = null
    state.startedAt = null
    state.lastFinalSegment = -1
    setPhase('preparing', '正在准备…')
    try {
      await ensurePythonDependencies()
      if (lifetime.signal.aborted) return
      const python = findPython()
      const args = [
        '-u',
        ENGINE,
        '--lang',
        state.sourceLanguage,
        '--font-size',
        String(state.fontSize),
        '--opacity',
        String(state.opacity),
        '--position',
        state.position,
        '--asr-model-dir',
        asrModelDirectory('base'),
        '--asr-repo',
        'Systran/faster-whisper-base',
        '--asr-draft-model-dir',
        asrModelDirectory('tiny'),
        '--asr-draft-repo',
        'Systran/faster-whisper-tiny',
        '--asr-device',
        config.asrDevice === 'cuda' ? 'cuda' : 'cpu',
        '--asr-compute',
        config.asrDevice === 'cuda' ? 'float16' : 'int8',
      ]
      if (config.device) args.push('--device', config.device)
      const generation = ++childGeneration
      child = spawn(python, args, {
        windowsHide: true,
        cwd: path.dirname(ENGINE),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      attachEngine(child, generation)
      if (lifetime.signal.aborted || stopping) {
        try {
          child.stdin?.write('{"cmd":"quit"}\n')
          child.kill()
        } catch {
          // ignore
        }
        child = null
        return
      }
      setPhase('listening', '正在监听系统音频…')
    } catch (error) {
      if (lifetime.signal.aborted || stopping) {
        state.running = false
        setPhase('idle', '')
        return
      }
      log(`start failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
      state.running = false
      setError(error, '启动失败')
    } finally {
      starting = false
    }
  }

  async function stop(reason = 'user') {
    if (stopping) return
    stopping = true
    lifetime.abort(new Error('subtitles stopped'))
    transcriptionQueue.length = 0
    const instance = child
    child = null
    childGeneration += 1
    if (instance) {
      try {
        instance.stdin?.write('{"cmd":"quit"}\n')
      } catch {
        // ignore
      }
      try {
        await Promise.race([
          new Promise((resolve) => instance.once('exit', resolve)),
          sleep(2200),
        ])
      } catch {
        // ignore
      }
      if (!instance.killed) {
        try {
          instance.kill()
        } catch {
          // ignore
        }
      }
    }
    if (starting || (state.preparation && !['ready', 'standby'].includes(state.preparation.phase))) {
      try {
        await ctx.speechToText.cancelPreparation(PROVIDER_ID)
      } catch {
        // ignore
      }
    }
    state.running = false
    state.speaking = false
    state.level = 0
    state.pending = null
    state.startedAt = null
    setPhase('idle', reason === 'user' ? '' : '已停止')
    stopping = false
    scheduleState()
  }

  ctx.effect(() => () => {
    stopping = true
    childGeneration += 1
    try {
      if (stateTimer) clearTimeout(stateTimer)
    } catch {
      // ignore
    }
    for (const response of clients) {
      try {
        response.end()
      } catch {
        // ignore
      }
    }
    clients.clear()
    disposeRoute()
    if (child) {
      const instance = child
      child = null
      try {
        instance.stdin?.write('{"cmd":"quit"}\n')
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          instance.kill()
        } catch {
          // ignore
        }
      }, 800)
    }
  }, 'realtime-subtitles: shutdown')

  log(`ready (engine=${ENGINE})`)
}
