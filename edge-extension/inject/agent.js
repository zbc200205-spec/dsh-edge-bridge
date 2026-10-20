/**
 * DSH Edge Bridge — 扩展端页面操作层（注入到页面的 isolated world）。
 *
 * 该文件由 background 通过 chrome.scripting.executeScript({files:['inject/agent.js']})
 * 注入；同一扩展的 isolated world 在所有注入之间共享，因此这里把 API 挂在 globalThis 上，
 * 后续调用直接用 executeScript({func}) 读取。
 *
 * 能力：可见元素快照（带稳定 ref）、按 ref/选择器/文本查找、DOM 点击、输入、按键、滚动、等待。
 * 真实（isTrusted）输入由 background 走 chrome.debugger/CDP 完成，本文件只负责 DOM 语义与元素定位。
 */
;(() => {
  const VERSION = '0.1.0'
  const REF_ATTR = 'data-dsh-edge-ref'
  if (globalThis.__DSH_EDGE__ && globalThis.__DSH_EDGE__.version === VERSION) return

  // ---------------------------------------------------------------- utilities
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

  function isElement(node) {
    return node instanceof Element
  }

  /** 元素是否“可见可交互”。 */
  function isVisible(el) {
    if (!isElement(el)) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 1 && rect.height <= 1) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number(style.opacity) === 0) return false
    if (el.hasAttribute('hidden')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    return true
  }

  function isDisabled(el) {
    if (el.disabled === true) return true
    if (el.getAttribute('aria-disabled') === 'true') return true
    if (el.closest && el.closest('[disabled],[aria-disabled="true"]')) return true
    return false
  }

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    'label[for]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="slider"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  /** 元素的“可读名字”：尽量贴近无障碍名称。 */
  function accessibleName(el) {
    const direct = norm(el.getAttribute('aria-label'))
    if (direct) return direct
    const labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id)
          return ref ? norm(ref.innerText || ref.textContent) : ''
        })
        .filter(Boolean)
      if (parts.length) return parts.join(' ')
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (lab) return norm(lab.innerText || lab.textContent)
      }
      const wrap = el.closest('label')
      if (wrap) return norm(wrap.innerText || wrap.textContent)
      const ph = norm(el.getAttribute('placeholder'))
      if (ph) return ph
      const name = norm(el.getAttribute('name'))
      if (name) return name
      if (tag === 'input' && el.type !== 'password' && el.value) return norm(el.value)
      return ''
    }
    const title = norm(el.getAttribute('title'))
    if (title) return title
    const img = el.querySelector && el.querySelector('img[alt]')
    if (img) {
      const alt = norm(img.getAttribute('alt'))
      if (alt) return alt
    }
    const text = norm(el.innerText || el.textContent)
    if (text) return text.length > 120 ? text.slice(0, 120) + '…' : text
    const alt = norm(el.getAttribute('alt'))
    if (alt) return alt
    return ''
  }

  function roleOf(el) {
    const explicit = norm(el.getAttribute('role'))
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'file') return 'file'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return 'generic'
  }

  function boxOf(el) {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left * 100) / 100,
      y: Math.round(r.top * 100) / 100,
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      cx: Math.round((r.left + r.width / 2) * 100) / 100,
      cy: Math.round((r.top + r.height / 2) * 100) / 100,
    }
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight || document.documentElement.clientHeight
    const vw = window.innerWidth || document.documentElement.clientWidth
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
  }

  /** 元素是否是“容器级”可交互元素（用于文本命中时收敛到真正的可点元素）。 */
  function clickableAncestor(el) {
    let node = el
    while (node && node !== document.documentElement) {
      if (node.matches && node.matches(INTERACTIVE_SELECTOR) && isVisible(node) && !isDisabled(node)) return node
      node = node.parentElement
    }
    return null
  }

  // ------------------------------------------------------------------ refs
  function clearRefs() {
    document.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR))
  }

  function resolveRef(ref) {
    if (ref == null) return null
    const value = String(ref).replace(/^@/, '')
    if (!/^\d+$/.test(value)) return null
    return document.querySelector(`[${REF_ATTR}="${value}"]`)
  }

  function resolveTarget(target) {
    if (!target || typeof target !== 'object') throw new Error('缺少目标：需要 ref / selector / text 之一')
    if (target.ref != null) {
      const el = resolveRef(target.ref)
      if (!el) throw new Error(`ref=${target.ref} 已失效，请重新调用一次快照（snapshot）再操作`)
      return el
    }
    if (target.selector) {
      let el = null
      try {
        el = document.querySelector(target.selector)
      } catch (err) {
        throw new Error(`selector 非法：${target.selector}（${err && err.message}）`)
      }
      if (!el) throw new Error(`selector 未命中元素：${target.selector}`)
      return el
    }
    if (target.text) {
      const el = findByText(target.text, { exact: target.exact === true, role: target.role })
      if (!el) throw new Error(`按文本未找到可点击元素：${JSON.stringify(target.text)}`)
      return el
    }
    throw new Error('缺少目标：需要 ref / selector / text 之一')
  }

  function findByText(text, options = {}) {
    const needle = norm(text).toLowerCase()
    if (!needle) return null
    const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
      (el) => isVisible(el) && !isDisabled(el),
    )
    let best = null
    let bestScore = Infinity
    for (const el of candidates) {
      const role = roleOf(el)
      if (options.role && role !== options.role) continue
      const name = accessibleName(el).toLowerCase()
      const inner = norm(el.innerText || el.textContent).toLowerCase()
      let score = null
      if (name === needle || inner === needle) score = 0
      else if (name.startsWith(needle)) score = 1
      else if (name.includes(needle)) score = 2 + name.length / 1000
      else if (inner.includes(needle)) score = 3 + inner.length / 1000
      if (score === null) continue
      if (options.exact === true && score > 0) continue
      // 优先“更小更专一”的元素，避免点到大容器
      score += Math.min(1, (el.getBoundingClientRect().width * el.getBoundingClientRect().height) / 400000)
      score += inViewport(el) ? 0 : 0.5
      if (score < bestScore) {
        bestScore = score
        best = el
      }
    }
    if (best) return best
    // 退化路径：文本节点所在位置向上找可点祖先
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (!norm(node.nodeValue)) continue
      if (!norm(node.nodeValue).toLowerCase().includes(needle)) continue
      const ancestor = clickableAncestor(node.parentElement)
      if (ancestor) return ancestor
    }
    return null
  }

  // --------------------------------------------------------------- snapshot
  function snapshot(options = {}) {
    const maxElements = Math.min(Math.max(Number(options.maxElements) || 120, 1), 400)
    const includeText = options.includeText !== false
    const maxText = Math.min(Math.max(Number(options.maxText) || 4000, 0), 20000)
    clearRefs()

    const seen = new Set()
    const all = []
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (seen.has(el)) continue
      seen.add(el)
      if (!isVisible(el)) continue
      const tag = el.tagName.toLowerCase()
      // 隐藏的原生控件（file/checkbox 的自定义外壳）仍然保留，交给调用方判断
      all.push(el)
    }

    // 视口内的元素排前面，保证 cap 截断时优先保留“看得见”的部分
    all.sort((a, b) => (inViewport(b) ? 1 : 0) - (inViewport(a) ? 1 : 0))

    const elements = []
    let index = 0
    for (const el of all) {
      if (index >= maxElements) break
      const ref = String(index)
      el.setAttribute(REF_ATTR, ref)
      index += 1
      const tag = el.tagName.toLowerCase()
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : undefined
      const entry = {
        ref,
        tag,
        role: roleOf(el),
        name: accessibleName(el),
        box: boxOf(el),
        inViewport: inViewport(el),
        disabled: isDisabled(el),
      }
      if (type) entry.type = type
      if (el.id) entry.id = el.id
      const href = el.getAttribute && el.getAttribute('href')
      if (href) entry.href = href.length > 200 ? href.slice(0, 200) + '…' : href
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (type === 'password') entry.hasValue = !!el.value
        else if (type === 'checkbox' || type === 'radio') entry.checked = !!el.checked
        else if (tag === 'select') entry.value = norm(el.value)
        else entry.value = el.value ? norm(el.value).slice(0, 200) : ''
        if (el.getAttribute('placeholder')) entry.placeholder = el.getAttribute('placeholder')
      }
      if (el.isContentEditable) entry.editable = true
      elements.push(entry)
    }

    let text = ''
    if (includeText) {
      const body = document.body || document.documentElement
      text = norm(body.innerText || body.textContent || '')
      if (text.length > maxText) text = text.slice(0, maxText) + '…'
    }

    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio,
      },
      text,
      elements,
      truncated: all.length > elements.length,
      total: all.length,
      refCount: elements.length,
    }
  }

  // ------------------------------------------------------------------ click
  function mouseInit(el, extra = {}) {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    return Object.assign(
      {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: 1,
        detail: 1,
      },
      extra,
    )
  }

  /** DOM 合成点击：先补 pointer/mouse 事件序列，再用 el.click() 触发原生默认行为。 */
  function domClick(el, options = {}) {
    if (isDisabled(el)) throw new Error('目标元素处于 disabled/aria-disabled 状态')
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch {
      el.scrollIntoView()
    }
    if (typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: true })
      } catch {
        /* ignore */
      }
    }
    const pointerInit = mouseInit(el, { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 })
    const down = mouseInit(el)
    const up = mouseInit(el, { buttons: 0 })
    try {
      el.dispatchEvent(new PointerEvent('pointerover', pointerInit))
      el.dispatchEvent(new PointerEvent('pointerenter', pointerInit))
      el.dispatchEvent(new MouseEvent('mouseover', down))
      el.dispatchEvent(new PointerEvent('pointerdown', pointerInit))
      el.dispatchEvent(new MouseEvent('mousedown', down))
    } catch {
      /* 某些旧环境没有 PointerEvent */
    }
    try {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointerInit, { buttons: 0 })))
    } catch {
      /* ignore */
    }
    el.dispatchEvent(new MouseEvent('mouseup', up))
    if (typeof el.click === 'function') el.click()
    else el.dispatchEvent(new MouseEvent('click', up))
    const r = el.getBoundingClientRect()
    return { box: boxOf(el), at: { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  }

  // ------------------------------------------------------------------- input
  function nativeValueSetter(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
  }

  function fireInput(el, data) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: data == null ? null : String(data) }))
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }

  function focusElement(el) {
    if (typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: false })
      } catch {
        el.focus()
      }
    }
  }

  /** 逐字符输入（会派发 keydown/keypress/keyup，更接近真人），并兼容 React 受控组件。 */
  function domType(el, text, options = {}) {
    if (isDisabled(el)) throw new Error('目标元素处于 disabled/aria-disabled 状态')
    const value = String(text == null ? '' : text)
    const clear = options.clear !== false
    const delay = Math.min(Math.max(Number(options.delayMs) || 0, 0), 2000)
    focusElement(el)
    const editable = el.isContentEditable
    if (!editable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      throw new Error(`目标元素不可输入（tag=${el.tagName.toLowerCase()}），请选择 input/textarea/contenteditable`)
    }
    if (clear) {
      if (editable) {
        el.textContent = ''
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: '' }))
      } else {
        nativeValueSetter(el, '')
        fireInput(el, '')
      }
    }
    const before = editable ? el.textContent || '' : el.value || ''
    let current = clear ? '' : before
    for (const ch of value) {
      const keyInit = { key: ch, bubbles: true, cancelable: true, composed: true }
      el.dispatchEvent(new KeyboardEvent('keydown', keyInit))
      el.dispatchEvent(new KeyboardEvent('keypress', keyInit))
      current += ch
      if (editable) {
        el.textContent = current
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }))
      } else {
        nativeValueSetter(el, current)
        el.dispatchEvent(
          new InputEvent('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }),
        )
        el.dispatchEvent(new KeyboardEvent('keyup', keyInit))
      }
      if (delay) {
        // 同步等待会阻塞页面；用忙等保证顺序，步长很小
        const until = performance.now() + delay
        while (performance.now() < until) {
          /* busy wait */
        }
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    const finalValue = editable ? el.textContent || '' : el.value || ''
    return { value: finalValue, length: finalValue.length, editable, changed: finalValue !== before }
  }

  const KEY_CODES = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
  }

  /** DOM 合成的按键事件（isTrusted=false；真实按键请用 background 的 CDP 通道）。 */
  function domKey(el, key, options = {}) {
    const target = el || document.activeElement || document.body
    const code = KEY_CODES[key]
    const init = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      keyCode: code,
      which: code,
      bubbles: true,
      cancelable: true,
      composed: true,
      altKey: !!options.altKey,
      ctrlKey: !!options.ctrlKey,
      metaKey: !!options.metaKey,
      shiftKey: !!options.shiftKey,
    }
    target.dispatchEvent(new KeyboardEvent('keydown', init))
    if (key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', init))
    target.dispatchEvent(new KeyboardEvent('keyup', init))
    let submitted = false
    if (key === 'Enter' && options.submit !== false) {
      const form = target.form || (target.closest && target.closest('form'))
      if (form && typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit()
          submitted = true
        } catch {
          /* ignore */
        }
      }
    }
    return { key, submitted }
  }

  function domScroll(options = {}) {
    let el = null
    if (options.ref != null || options.selector || options.text) el = resolveTarget(options)
    const target = el || window
    const dx = Number(options.dx) || 0
    let dy = Number(options.dy)
    if (!Number.isFinite(dy)) dy = options.to === 'bottom' ? 100000 : 600
    if (options.to === 'top') dy = -100000
    if (el) el.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    else window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) }
  }

  function domWait(options = {}) {
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 8000, 100), 120000)
    const pollMs = Math.min(Math.max(Number(options.pollMs) || 120, 30), 2000)
    const started = Date.now()
    poked = true
    return { timeoutMs, pollMs, started }
  }

  // wait 需要异步轮询：交给 background 用 executeScript 反复调用 probe
  let poked = false

  function probe(options = {}) {
    if (options.selector) {
      let el = null
      try {
        el = document.querySelector(options.selector)
      } catch (err) {
        return { matched: false, error: `selector 非法：${err && err.message}` }
      }
      if (!el) return { matched: false, reason: 'selector-not-found' }
      if (options.visible !== false && !isVisible(el)) return { matched: false, reason: 'selector-not-visible' }
      return { matched: true, reason: 'selector', name: accessibleName(el) }
    }
    if (options.text) {
      const el = findByText(options.text, { exact: options.exact === true })
      if (!el) return { matched: false, reason: 'text-not-found' }
      return { matched: true, reason: 'text', name: accessibleName(el), ref: el.getAttribute(REF_ATTR) }
    }
    if (options.urlContains) {
      const ok = location.href.includes(options.urlContains)
      return { matched: ok, reason: 'url', url: location.href }
    }
    // 注意：这里不做任意表达式求值——隔离世界禁止 eval/new Function，
    // 需要 fn 条件时由 background 走 CDP（见 commands.js 的 wait 与 cdp.evaluate）。
    return { matched: true, reason: 'no-condition' }
  }

  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      hasFocus: document.hasFocus(),
    }
  }

  function highlight(ref) {
    const el = resolveRef(ref)
    if (!el) return { ok: false }
    const r = el.getBoundingClientRect()
    const box = document.createElement('div')
    box.setAttribute('data-dsh-edge-highlight', '1')
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;
      outline:2px solid #ff4d4f;background:rgba(255,77,79,.12);z-index:2147483647;pointer-events:none;border-radius:3px;`
    document.documentElement.appendChild(box)
    setTimeout(() => box.remove(), 1200)
    return { ok: true, box: boxOf(el) }
  }

  const api = {
    version: VERSION,
    snapshot,
    pageInfo,
    resolveTargetInfo(target) {
      const el = resolveTarget(target)
      return { tag: el.tagName.toLowerCase(), name: accessibleName(el), box: boxOf(el), ref: el.getAttribute(REF_ATTR) }
    },
    click(target, options) {
      const el = resolveTarget(target)
      return Object.assign({ target: { tag: el.tagName.toLowerCase(), name: accessibleName(el), ref: el.getAttribute(REF_ATTR) } }, domClick(el, options || {}))
    },
    type(target, text, options) {
      const el = resolveTarget(target)
      return Object.assign({ target: { tag: el.tagName.toLowerCase(), name: accessibleName(el), ref: el.getAttribute(REF_ATTR) } }, domType(el, text, options || {}))
    },
    key(target, key, options) {
      let el = null
      if (target && (target.ref != null || target.selector || target.text)) el = resolveTarget(target)
      return domKey(el, key, options || {})
    },
    scroll: domScroll,
    probe,
    highlight,
    findByTextInfo(text, options) {
      const el = findByText(text, options || {})
      if (!el) return null
      return { tag: el.tagName.toLowerCase(), name: accessibleName(el), ref: el.getAttribute(REF_ATTR), box: boxOf(el) }
    },
    focusTarget(target) {
      const el = resolveTarget(target)
      focusElement(el)
      return { tag: el.tagName.toLowerCase(), name: accessibleName(el) }
    },
    boxOfTarget(target) {
      const el = resolveTarget(target)
      if (!inViewport(el)) {
        try {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        } catch {
          /* ignore */
        }
      }
      return { box: boxOf(el), inViewport: inViewport(el) }
    },
    readTarget(target) {
      const el = resolveTarget(target)
      const tag = el.tagName.toLowerCase()
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : undefined
      const out = { tag, type, name: accessibleName(el), ref: el.getAttribute(REF_ATTR) }
      if (tag === 'input' || tag === 'textarea') {
        out.value = type === 'password' ? (el.value ? '<hidden>' : '') : el.value
        if (type === 'checkbox' || type === 'radio') out.checked = !!el.checked
      } else if (tag === 'select') {
        out.value = el.value
        out.selectedText = el.selectedOptions && el.selectedOptions[0] ? norm(el.selectedOptions[0].textContent) : ''
      } else if (el.isContentEditable) {
        out.value = norm(el.textContent)
      } else {
        out.value = norm(el.innerText || el.textContent)
      }
      return out
    },
    describe(target) {
      const el = resolveTarget(target)
      return {
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: accessibleName(el),
        box: boxOf(el),
        inViewport: inViewport(el),
        ref: el.getAttribute(REF_ATTR),
      }
    },
  }

  globalThis.__DSH_EDGE__ = api
})()
