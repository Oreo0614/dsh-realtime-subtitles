window.__ModuleLoader__.load({
  id: 'dsh-realtime-subtitles',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const NS = 'realtimeSubtitles'
    const ROUTE = '/api/realtime-subtitles'

    const DICTIONARIES = {
      zh: {
        'panel.label': '实时字幕',
        'page.title': '实时字幕',
        'page.subtitle': '跟随电脑里播放的视频声音，实时识别日语或英语并翻译成中文字幕。',
        'status.idle': '未启动',
        'status.preparing': '准备中',
        'status.listening': '正在监听',
        'status.error': '需要注意',
        'action.start': '开始字幕',
        'action.stop': '停止',
        'action.retry': '重试',
        'field.source': '视频语言',
        'field.target': '字幕语言',
        'field.overlay': '桌面悬浮字幕',
        'field.overlayHint': '字幕会浮在播放器上方，鼠标可以穿透。',
        'field.fontSize': '字号',
        'field.position': '位置',
        'overlay.on': '开',
        'overlay.off': '关',
        'source.ja': '日语',
        'source.en': '英语',
        'source.auto': '自动检测',
        'target.zh': '简体中文',
        'target.en': '英语',
        'position.bottom': '底部',
        'position.top': '顶部',
        'hint.title': '三步开始',
        'hint.step1': '在电脑上打开并播放日语或英语视频。',
        'hint.step2': '点击“开始字幕”，首次使用会准备本地语音模型。',
        'hint.step3': '译文会显示在下方，并同步浮在播放器上方。',
        'hint.note': '声音来自系统扬声器，不需要麦克风；请让视频声音正常外放。',
        'live.title': '字幕流',
        'live.empty': '还没有识别到语音。开始播放视频后，字幕会出现在这里。',
        'live.listening': '正在聆听视频里的说话声…',
        'live.pending': '识别中',
        'live.liveTranslation': '实时翻译',
        'live.translating': '翻译中',
        'live.sourceOnly': '仅原文',
        'live.clear': '清空',
        'prep.title': '正在准备本地语音模型',
        'prep.downloading': '下载语音模型',
        'prep.verifying': '校验模型文件',
        'prep.loading': '加载识别引擎',
        'prep.checking': '检查本地缓存',
        'prep.ready': '模型已就绪',
        'prep.firstUse': '首次使用需要下载 Whisper tiny/base 模型（约 220 MB），之后启动会直接复用缓存。',
        'prep.step.check': '检查缓存',
        'prep.step.model': '语音模型',
        'prep.step.vad': '人声检测',
        'prep.step.verify': '完整性校验',
        'prep.step.load': '加载引擎',
        'error.title': '字幕暂时不可用',
        'error.generic': '发生未知错误，请重试。',
        'device.system': '系统扬声器',
        'device.vad': '人声检测',
        'device.python': '音频引擎',
        'footer.note': '本地识别 · 匿名翻译 · 音频不会上传',
        'empty.badge': '实时',
      },
      en: {
        'panel.label': 'Live subtitles',
        'page.title': 'Live subtitles',
        'page.subtitle': 'Follow video audio playing on this computer, recognize Japanese or English speech, and translate it into Chinese subtitles in real time.',
        'status.idle': 'Idle',
        'status.preparing': 'Preparing',
        'status.listening': 'Listening',
        'status.error': 'Needs attention',
        'action.start': 'Start subtitles',
        'action.stop': 'Stop',
        'action.retry': 'Retry',
        'field.source': 'Video language',
        'field.target': 'Subtitle language',
        'field.overlay': 'Desktop overlay',
        'field.overlayHint': 'Subtitles float above the player and let clicks pass through.',
        'field.fontSize': 'Font size',
        'field.position': 'Position',
        'overlay.on': 'On',
        'overlay.off': 'Off',
        'source.ja': 'Japanese',
        'source.en': 'English',
        'source.auto': 'Auto detect',
        'target.zh': 'Simplified Chinese',
        'target.en': 'English',
        'position.bottom': 'Bottom',
        'position.top': 'Top',
        'hint.title': 'Start in three steps',
        'hint.step1': 'Open and play a Japanese or English video on this computer.',
        'hint.step2': 'Choose Start subtitles. The first run prepares a local speech model.',
        'hint.step3': 'Translations appear below and float above the video player.',
        'hint.note': 'Audio is captured from the system speakers, not the microphone. Keep the video audible.',
        'live.title': 'Subtitle stream',
        'live.empty': 'No speech detected yet. Subtitles will appear here once the video starts.',
        'live.listening': 'Listening to the video…',
        'live.pending': 'Recognizing',
        'live.liveTranslation': 'Live translation',
        'live.translating': 'Translating',
        'live.sourceOnly': 'Source only',
        'live.clear': 'Clear',
        'prep.title': 'Preparing the local speech model',
        'prep.downloading': 'Downloading speech model',
        'prep.verifying': 'Verifying model files',
        'prep.loading': 'Loading recognizer',
        'prep.checking': 'Checking the local cache',
        'prep.ready': 'Model ready',
        'prep.firstUse': 'The first run downloads the Whisper tiny/base models (~220 MB). Later starts reuse the cache.',
        'prep.step.check': 'Cache check',
        'prep.step.model': 'Speech model',
        'prep.step.vad': 'Voice detection',
        'prep.step.verify': 'Integrity check',
        'prep.step.load': 'Load engine',
        'error.title': 'Subtitles are unavailable',
        'error.generic': 'An unexpected error occurred. Try again.',
        'device.system': 'System speakers',
        'device.vad': 'Voice detection',
        'device.python': 'Audio engine',
        'footer.note': 'Local recognition · anonymous translation · audio never uploaded',
        'empty.badge': 'Live',
      },
    }

    const CSS = `
.rts-page{height:100%;overflow:auto;box-sizing:border-box;padding:28px 32px 56px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}
.rts-shell{width:100%;max-width:1080px;margin:0 auto;}
.rts-header{display:flex;align-items:flex-start;gap:16px;margin-bottom:24px;}
.rts-mark{width:44px;height:44px;border-radius:13px;display:flex;align-items:center;justify-content:center;flex:none;background:linear-gradient(145deg,#2f7df6,#7b5cff);color:#fff;box-shadow:0 8px 22px rgba(47,125,246,.28);}
.rts-heading{min-width:0;flex:1;}
.rts-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0;font-size:22px;line-height:30px;font-weight:650;letter-spacing:-.01em;}
.rts-subtitle{margin:5px 0 0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);max-width:760px;}
.rts-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-button-ghost-active-fill);border:1px solid var(--dsw-alias-border-l1);}
.rts-status{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.rts-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none;}
.rts-status[data-phase=listening] .rts-dot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);}
.rts-status[data-phase=preparing] .rts-dot{background:var(--dsw-alias-state-warn-primary);animation:rts-pulse 1.2s ease-in-out infinite;}
.rts-status[data-phase=error] .rts-dot{background:var(--dsw-alias-state-error-primary);}
@keyframes rts-pulse{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}
.rts-toolbar{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);margin-bottom:18px;}
.rts-field{display:flex;flex-direction:column;gap:6px;min-width:132px;}
.rts-label{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);}
.rts-select,.rts-input{height:34px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px;outline:none;}
.rts-select:focus-visible,.rts-input:focus-visible,.rts-button:focus-visible,.rts-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.rts-select:disabled{opacity:.55;cursor:not-allowed;}
.rts-grow{flex:1;}
.rts-button{height:36px;padding:0 17px;border-radius:8px;border:1px solid transparent;font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap;transition:background .15s ease,opacity .15s ease;}
.rts-button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);}
.rts-button.primary:hover{background:var(--dsw-alias-button-primary-hover);}
.rts-button.danger{background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l2);}
.rts-button:disabled{opacity:.55;cursor:default;}
.rts-content{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(250px,1fr);gap:16px;align-items:start;}
.rts-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.rts-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.rts-card-title{margin:0;font-size:13px;line-height:20px;font-weight:650;}
.rts-card-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.rts-stream{min-height:270px;max-height:calc(100vh - 360px);overflow:auto;padding:8px;}
.rts-live-now{display:flex;gap:11px;padding:12px;margin:2px 2px 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}
.rts-wave{display:flex;align-items:center;gap:2px;flex:none;height:22px;width:24px;}
.rts-wave span{width:3px;border-radius:2px;background:var(--dsw-alias-brand-primary);height:6px;transition:height .12s ease;}
.rts-now-text{min-width:0;flex:1;font-size:14px;line-height:22px;}
.rts-now-label{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);margin-bottom:2px;}
.rts-line{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;padding:11px 10px;border-radius:9px;}
.rts-line:hover{background:var(--dsw-alias-interactive-bg-hover);}
.rts-time{font-size:10px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;padding-top:2px;}
.rts-translation{font-size:15px;line-height:23px;font-weight:550;word-break:break-word;}
.rts-source{margin-top:3px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-word;}
.rts-line[data-status=translating] .rts-translation{color:var(--dsw-alias-label-tertiary);font-weight:400;}
.rts-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:11px;min-height:250px;padding:30px;color:var(--dsw-alias-label-secondary);}
.rts-empty-icon{width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);}
.rts-empty p{margin:0;max-width:330px;font-size:12px;line-height:20px;}
.rts-side{display:flex;flex-direction:column;gap:16px;}
.rts-panel{padding:15px 16px 17px;}
.rts-panel h3{margin:0 0 12px;font-size:12px;line-height:18px;font-weight:650;color:var(--dsw-alias-label-secondary);}
.rts-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0 12px;}
.rts-switch-copy{min-width:0;}
.rts-switch-title{font-size:13px;line-height:19px;font-weight:550;}
.rts-switch-hint{margin-top:2px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.rts-switch{position:relative;width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;flex:none;padding:0;transition:background .16s ease;}
.rts-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .16s ease,background .16s ease;}
.rts-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:transparent;}
.rts-switch[aria-checked=true]::after{transform:translateX(16px);background:#fff;}
.rts-range{width:100%;accent-color:var(--dsw-alias-brand-primary);}
.rts-seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);gap:2px;}
.rts-seg button{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;height:26px;padding:0 11px;cursor:pointer;}
.rts-seg button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgba(0,0,0,.1);}
.rts-hints{padding:15px 16px;}
.rts-hints ol{margin:0;padding-left:17px;display:flex;flex-direction:column;gap:8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.rts-hints li::marker{color:var(--dsw-alias-brand-primary);font-weight:650;}
.rts-note{margin:12px 0 0;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10px;line-height:17px;color:var(--dsw-alias-label-tertiary);}
.rts-prep{padding:15px 16px;margin-bottom:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);}
.rts-prep-top{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;font-weight:600;}
.rts-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;margin:11px 0 9px;}
.rts-bar span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s ease;}
.rts-bar.indeterminate span{width:36%;animation:rts-slide 1.4s ease-in-out infinite;}
@keyframes rts-slide{0%{transform:translateX(-100%)}100%{transform:translateX(310%)}}
.rts-prep-hint{font-size:10px;line-height:17px;color:var(--dsw-alias-label-tertiary);}
.rts-steps{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}
.rts-step{font-size:9px;line-height:17px;padding:0 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);}
.rts-step[data-status=complete]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);}
.rts-step[data-status=running]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);}
.rts-error{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;margin-bottom:16px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);font-size:11px;line-height:18px;color:var(--dsw-alias-state-error-primary);}
.rts-error b{font-weight:650;}
.rts-error p{margin:0;}
.rts-footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:18px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.rts-footer .dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.5;}
.rts-devmeta{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;font-size:10px;color:var(--dsw-alias-label-tertiary);}
@media (max-width:820px){.rts-page{padding:20px 16px 40px}.rts-content{grid-template-columns:minmax(0,1fr)}.rts-stream{max-height:none}.rts-toolbar{align-items:stretch}.rts-field{flex:1 1 140px}.rts-toolbar .rts-grow{display:none}.rts-toolbar .rts-button{width:100%}}
`

    function fallbackT(key) {
      const dictionaries = DICTIONARIES.zh
      return dictionaries[key] ?? key
    }

    function formatTime(value) {
      try {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch {
        return ''
      }
    }

    function Icon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M5.6 3.5h12.8a3.1 3.1 0 0 1 3.1 3.1v8.2a3.1 3.1 0 0 1-3.1 3.1h-6.1L7.6 21v-3.1H5.6a3.1 3.1 0 0 1-3.1-3.1V6.6a3.1 3.1 0 0 1 3.1-3.1Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M6.4 8.1h11.2M6.4 11.2h7.4M6.4 14.3h9.2',
          stroke: 'var(--dsw-alias-bg-base, #0b1020)',
          strokeWidth: 1.55,
          strokeLinecap: 'round',
        }),
      )
    }

    function IconWave() {
      return h(
        'svg',
        {
          width: 46,
          height: 46,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
        },
        h('path', {
          d: 'M4 10v4m4-7v10m4-13v16m4-11v6m4-3v0',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    function Meter({ level }) {
      return h(
        'div',
        { className: 'rts-wave', 'aria-hidden': true },
        [0, 1, 2, 3, 4].map((index) =>
          h('span', {
            key: index,
            style: {
              height: `${5 + Math.round(Math.min(1, Math.max(0, level)) * 17 * (0.55 + 0.45 * Math.sin((index + 1) * 1.7)))}px`,
            },
          }),
        ),
      )
    }

    function StatusPill({ phase, t }) {
      const key =
        phase === 'listening'
          ? 'status.listening'
          : phase === 'preparing'
            ? 'status.preparing'
            : phase === 'error'
              ? 'status.error'
              : 'status.idle'
      return h(
        'span',
        { className: 'rts-status', 'data-phase': phase, role: 'status' },
        h('span', { className: 'rts-dot' }),
        t(key),
      )
    }

    function Preparation({ state, t }) {
      const prep = state.preparation
      const phase = prep?.phase || 'checking'
      const total = Number(prep?.totalBytes)
      const done = Number(prep?.completedBytes)
      const hasPercent = Number.isFinite(total) && total > 0 && Number.isFinite(done)
      const percent = hasPercent ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
      const label =
        phase === 'downloading'
          ? t('prep.downloading')
          : phase === 'verifying'
            ? t('prep.verifying')
            : phase === 'loading'
              ? t('prep.loading')
              : t('prep.checking')
      const steps = Array.isArray(prep?.steps) ? prep.steps : []
      return h(
        'section',
        { className: 'rts-prep', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'rts-prep-top' },
          h('span', null, `${t('prep.title')} · ${label}`),
          hasPercent ? h('span', { className: 'rts-card-meta' }, `${percent}%`) : null,
        ),
        h(
          'div',
          { className: `rts-bar${hasPercent ? '' : ' indeterminate'}`, role: 'progressbar', 'aria-valuenow': hasPercent ? percent : undefined, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('span', { style: hasPercent ? { width: `${percent}%` } : undefined }),
        ),
        h('div', { className: 'rts-prep-hint' }, t('prep.firstUse')),
        steps.length
          ? h(
              'div',
              { className: 'rts-steps' },
              steps.map((step) =>
                h(
                  'span',
                  { key: step.kind, className: 'rts-step', 'data-status': step.status },
                  t(`prep.step.${step.kind}`) || step.kind,
                ),
              ),
            )
          : null,
      )
    }

    function LiveStream({ state, t, onClear }) {
      const segments = Array.isArray(state.segments) ? state.segments.slice().reverse() : []
      const pending = state.pending
      return h(
        'section',
        { className: 'rts-card', 'aria-label': t('live.title') },
        h(
          'div',
          { className: 'rts-card-head' },
          h('h2', { className: 'rts-card-title' }, t('live.title')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', { className: 'rts-card-meta' }, `${segments.length}`),
            segments.length
              ? h('button', { type: 'button', className: 'rts-card-meta', onClick: onClear, style: { border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' } }, t('live.clear'))
              : null,
          ),
        ),
        h(
          'div',
          { className: 'rts-stream', 'aria-live': 'polite' },
          pending && pending.source
            ? h(
                'div',
                { className: 'rts-live-now' },
                h(Meter, { level: state.level || 0 }),
                h(
                  'div',
                  { className: 'rts-now-text' },
                  h('div', { className: 'rts-now-label' }, pending.translation ? t('live.liveTranslation') : t('live.pending')),
                  h('div', null, pending.translation || pending.source),
                  pending.translation ? h('div', { className: 'rts-source' }, pending.source) : null,
                ),
              )
            : null,
          segments.length === 0
            ? h(
                'div',
                { className: 'rts-empty' },
                h('span', { className: 'rts-empty-icon' }, h(IconWave)),
                h('p', null, state.running ? t('live.listening') : t('live.empty')),
              )
            : segments.map((segment) =>
                h(
                  'article',
                  { key: segment.id, className: 'rts-line', 'data-status': segment.status },
                  h('time', { className: 'rts-time' }, formatTime(segment.at)),
                  h(
                    'div',
                    null,
                    h('div', { className: 'rts-translation' }, segment.translation || segment.source),
                    h(
                      'div',
                      { className: 'rts-source' },
                      segment.status === 'translating' ? `${t('live.translating')} · ` : '',
                      segment.source,
                    ),
                  ),
                ),
              ),
        ),
      )
    }

    function SidePanel({ state, t, disabled, onChangeOverlay }) {
      const overlay = state.overlayVisible
      return h(
        'aside',
        { className: 'rts-side' },
        h(
          'section',
          { className: 'rts-card rts-panel' },
          h('h3', null, t('field.overlay')),
          h(
            'div',
            { className: 'rts-switch-row' },
            h(
              'div',
              { className: 'rts-switch-copy' },
              h('div', { className: 'rts-switch-title' }, overlay ? t('overlay.on') : t('overlay.off')),
              h('div', { className: 'rts-switch-hint' }, t('field.overlayHint')),
            ),
            h('button', {
              type: 'button',
              className: 'rts-switch',
              role: 'switch',
              'aria-checked': overlay,
              'aria-label': t('field.overlay'),
              disabled,
              onClick: () => onChangeOverlay({ visible: !overlay }),
            }),
          ),
          h(
            'label',
            { className: 'rts-field', style: { marginBottom: 12 } },
            h('span', { className: 'rts-label' }, `${t('field.fontSize')} · ${state.fontSize}`),
            h('input', {
              className: 'rts-range',
              type: 'range',
              min: 18,
              max: 48,
              step: 1,
              value: state.fontSize,
              disabled,
              'aria-label': t('field.fontSize'),
              onChange: (event) => onChangeOverlay({ fontSize: Number(event.target.value) }),
            }),
          ),
          h(
            'div',
            { className: 'rts-field' },
            h('span', { className: 'rts-label' }, t('field.position')),
            h(
              'div',
              { className: 'rts-seg' },
              ['bottom', 'top'].map((position) =>
                h(
                  'button',
                  {
                    key: position,
                    type: 'button',
                    'aria-pressed': state.position === position,
                    disabled,
                    onClick: () => onChangeOverlay({ position }),
                  },
                  t(`position.${position}`),
                ),
              ),
            ),
          ),
        ),
        h(
          'section',
          { className: 'rts-card rts-hints' },
          h('h3', null, t('hint.title')),
          h(
            'ol',
            null,
            h('li', null, t('hint.step1')),
            h('li', null, t('hint.step2')),
            h('li', null, t('hint.step3')),
          ),
          h('p', { className: 'rts-note' }, t('hint.note')),
        ),
      )
    }

    function Page(props) {
      const t = props.t || fallbackT
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [connectionError, setConnectionError] = useState(null)
      const [localError, setLocalError] = useState(null)

      useEffect(() => {
        let active = true
        let events = null
        let retryTimer = null
        const apply = (next) => {
          if (!active) return
          setState(next)
          setConnectionError(null)
        }
        fetch(`${ROUTE}/state`, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then(apply)
          .catch((error) => active && setConnectionError(error.message))
        const connect = () => {
          if (!active) return
          events = new EventSource(`${ROUTE}/events`)
          events.onopen = () => {
            if (active) setConnectionError(null)
          }
          events.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data)
              if (message.type === 'state') apply(message.state)
              else if (message.type === 'level') {
                setState((current) => (current ? { ...current, level: message.level } : current))
              }
            } catch {
              // ignore malformed frame
            }
          }
          events.onerror = () => {
            if (!active) return
            setConnectionError('EventSource')
            try {
              events.close()
            } catch {
              // ignore
            }
            retryTimer = setTimeout(connect, 2000)
          }
        }
        connect()
        return () => {
          active = false
          if (retryTimer) clearTimeout(retryTimer)
          try {
            events?.close()
          } catch {
            // ignore
          }
        }
      }, [])

      const post = useCallback(async (path, body) => {
        const response = await fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const value = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
        if (value && value.segments) setState(value)
        return value
      }, [])

      const onStart = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setLocalError(null)
        try {
          await post('/start', {
            sourceLanguage: state?.sourceLanguage || 'ja',
            overlayVisible: state?.overlayVisible !== false,
            fontSize: state?.fontSize || 30,
            position: state?.position || 'bottom',
          })
        } catch (error) {
          setLocalError(error.message)
        } finally {
          setBusy(false)
        }
      }, [busy, post, state])

      const onStop = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setLocalError(null)
        try {
          await post('/stop')
        } catch (error) {
          setLocalError(error.message)
        } finally {
          setBusy(false)
        }
      }, [busy, post])

      const onChangeOverlay = useCallback(
        async (patch) => {
          setLocalError(null)
          if (state) setState({ ...state, ...patch })
          try {
            await post('/overlay', patch)
          } catch (error) {
            setLocalError(error.message)
          }
        },
        [post, state],
      )

      const onSourceChange = useCallback((event) => {
        const value = event.target.value
        setState((current) => (current ? { ...current, sourceLanguage: value } : current))
      }, [])

      const phase = state?.phase || (connectionError ? 'error' : 'idle')
      const error = localError || state?.error || (!state && connectionError ? `无法连接到字幕服务（${connectionError}）` : null)
      const canStart = !busy && !state?.running && phase !== 'preparing'
      const isPreparing = phase === 'preparing'
      const isListening = state?.running || phase === 'listening'

      if (!state && connectionError) {
        return h(
          'div',
          { className: 'rts-page' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'rts-shell' },
            h(
              'div',
              { className: 'rts-error' },
              h('div', null, h('b', null, t('error.title')), h('p', null, error)),
            ),
            h('button', { type: 'button', className: 'rts-button primary', onClick: () => location.reload() }, t('action.retry')),
          ),
        )
      }

      return h(
        'div',
        { className: 'rts-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'rts-shell' },
          h(
            'header',
            { className: 'rts-header' },
            h('span', { className: 'rts-mark' }, h(Icon, { size: 24 })),
            h(
              'div',
              { className: 'rts-heading' },
              h('h1', { className: 'rts-title' }, t('page.title'), h('span', { className: 'rts-badge' }, t('empty.badge'))),
              h('p', { className: 'rts-subtitle' }, t('page.subtitle')),
            ),
            h(StatusPill, { phase, t }),
          ),
          h(
            'div',
            { className: 'rts-toolbar' },
            h(
              'label',
              { className: 'rts-field' },
              h('span', { className: 'rts-label' }, t('field.source')),
              h(
                'select',
                {
                  className: 'rts-select',
                  value: state?.sourceLanguage || 'ja',
                  disabled: busy || isPreparing || isListening,
                  onChange: onSourceChange,
                },
                h('option', { value: 'ja' }, t('source.ja')),
                h('option', { value: 'en' }, t('source.en')),
                h('option', { value: 'auto' }, t('source.auto')),
              ),
            ),
            h(
              'label',
              { className: 'rts-field' },
              h('span', { className: 'rts-label' }, t('field.target')),
              h(
                'select',
                { className: 'rts-select', value: 'zh-CN', disabled: true },
                h('option', { value: 'zh-CN' }, t('target.zh')),
              ),
            ),
            h('span', { className: 'rts-grow' }),
            isListening
              ? h('button', { type: 'button', className: 'rts-button danger', onClick: onStop, disabled: busy }, t('action.stop'))
              : h('button', { type: 'button', className: 'rts-button primary', onClick: onStart, disabled: !canStart }, isPreparing ? t('status.preparing') : t('action.start')),
          ),
          error
            ? h(
                'div',
                { className: 'rts-error', role: 'alert' },
                h(
                  'div',
                  null,
                  h('b', null, t('error.title')),
                  h('p', null, error),
                ),
              )
            : null,
          isPreparing ? h(Preparation, { state, t }) : null,
          h(
            'div',
            { className: 'rts-content' },
            h(LiveStream, {
              state: state || { segments: [], pending: null, running: false },
              t,
              onClear: () => {
                setState((current) => (current ? { ...current, segments: [], pending: null } : current))
                post('/clear').catch((error) => setLocalError(error.message))
              },
            }),
            h(SidePanel, { state: state || { overlayVisible: true, fontSize: 30, position: 'bottom' }, t, disabled: busy, onChangeOverlay }),
          ),
          h(
            'footer',
            { className: 'rts-footer' },
            h('span', null, t('footer.note')),
            state?.device ? h('span', { className: 'dot' }) : null,
            state?.device ? h('span', null, `${t('device.system')}: ${state.device}`) : null,
            state?.vad ? h('span', { className: 'dot' }) : null,
            state?.vad ? h('span', null, `${t('device.vad')}: ${state.vad}`) : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'realtime-subtitles: locale')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'realtime-subtitles',
              order: 12,
              locale: NS,
              label: () => t('panel.label'),
            },
            Icon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'realtime-subtitles',
              locale: NS,
              inject: () => ({ t }),
            },
            Page,
          ),
        )
      },
    }
  },
})
