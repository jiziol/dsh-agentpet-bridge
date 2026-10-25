// Included in the Client ModuleLoader factory by scripts/build.mjs.
async function apply(ctx) {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  const dependency = await ctx.inject(['remote.agentPetBridge'], connectClient)
  return async () => { await dependency.dispose(); await unmount() }
}

async function connectClient(ctx) {
  let active = true
  let stream
  let hello
  let retryTimer
  const sent = new Map()
  const id = () => crypto.randomUUID()
  const boundedID = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  const report = () => {
    if (!hello || !stream || !active) return
    const statuses = ctx.uiSession.sessionStatus.getSnapshot()
    const visible = new Set()
    let count = 0
    for (const [nativeSessionID, status] of statuses) {
      if (!boundedID(nativeSessionID) || count++ >= 128) continue
      visible.add(nativeSessionID)
      const interaction = status.pendingInteraction
      let kind = { approval: 'permission', question: 'choice', 'plan-review': 'choice' }[interaction?.kind]
      if (interaction?.kind === 'question' && Array.isArray(interaction.questions) &&
          !interaction.questions.some(question => question.options?.length > 0)) kind = 'reply'
      const pending = kind && interaction.sessionId === nativeSessionID && boundedID(interaction.key) ? { id: interaction.key, kind } : null
      const key = JSON.stringify(pending)
      if (sent.get(nativeSessionID) === key) continue
      stream.send({ kind: 'pending', hostID: hello.hostID, generation: hello.generation, nativeSessionID, pending })
      sent.set(nativeSessionID, key)
    }
    for (const nativeSessionID of sent.keys()) {
      if (visible.has(nativeSessionID)) continue
      stream.send({ kind: 'pending', hostID: hello.hostID, generation: hello.generation, nativeSessionID, pending: null })
      sent.delete(nativeSessionID)
    }
  }
  const navigate = async request => {
    let ok = false
    let reference
    try {
      if (!active || request.hostID !== hello?.hostID || request.generation !== hello?.generation ||
          request.clientID !== hello?.clientID || !boundedID(request.nativeSessionID) ||
          !Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt ||
          !ctx.sessions.list.getSnapshot().byId[request.nativeSessionID]) return
      reference = ctx.sessions.retain(request.nativeSessionID, { source: 'agentpetBridge' })
      let timer
      const binding = await Promise.race([reference.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('load deadline')), Math.max(1, request.expiresAt - Date.now())) })]).finally(() => clearTimeout(timer))
      if (!active || Date.now() >= request.expiresAt || request.generation !== hello?.generation) return
      if (!request.verifyOnly) ctx.uiWorkspace.openSession(request.nativeSessionID)
      await Promise.resolve()
      ok = Date.now() < request.expiresAt && binding.session.getSnapshot().openState === 'open' &&
        ctx.sessions.retainInfo(request.nativeSessionID).getSnapshot().retainedBy.mainView > 0 &&
        ctx.layout.panelInfo.getSnapshot().activePanelId === null
    } catch { ok = false }
    finally {
      reference?.release()
      if (active && hello && request.generation === hello.generation) {
        stream.send({ kind: 'receipt', hostID: hello.hostID, generation: hello.generation,
          nativeSessionID: request.nativeSessionID, requestID: request.requestID, ok })
      }
    }
  }
  const connect = async () => {
    if (!active) return
    const current = ctx.remote.agentPetBridge.watch(id())
    stream = current
    try {
      for await (const frame of current) {
        if (!active || stream !== current) break
        if (frame.kind === 'hello') { hello = frame; sent.clear(); report() }
        else if (frame.kind === 'resync' && frame.generation === hello?.generation) { sent.clear(); report() }
        else if (frame.kind === 'navigate') await navigate(frame)
      }
    } catch { if (active) console.warn('[agentpet-bridge] Client connection unavailable') }
    finally {
      current.dispose(); hello = undefined; sent.clear()
      if (active) retryTimer = setTimeout(connect, 1000)
    }
  }
  const unsubscribe = ctx.uiSession.sessionStatus.subscribe(() => {
    try { report() } catch { stream?.dispose() }
  })
  const refresh = setInterval(() => { try { report() } catch { stream?.dispose() } }, 1000)
  void connect()
  return async () => {
    active = false; clearTimeout(retryTimer); clearInterval(refresh); unsubscribe(); stream?.dispose()
  }
}
return { apply, inject: ['remote', 'uiSession', 'sessions', 'uiWorkspace', 'layout'] }
