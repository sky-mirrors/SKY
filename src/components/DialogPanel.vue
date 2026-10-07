<template>
  <div class="dialog-panel" :class="{ collapsed: isCollapsed, docked }" :style="docked ? undefined : { width: isCollapsed ? '24px' : panelWidth + 'px' }">
    <div v-if="!docked" class="dialog-toggle" @click="isCollapsed = !isCollapsed">
      <span v-if="isCollapsed" class="toggle-expand">▶</span>
      <span v-else class="toggle-collapse">◀</span>
      <span v-if="isCollapsed" class="toggle-label">展开</span>
    </div>
    <div class="resize-handle" v-if="!isCollapsed && !docked" @mousedown="startResize"></div>
    <div class="dialog-inner" v-if="!isCollapsed">
      <div class="dialog-main">
      <div class="dialog-header">
        <div class="mode-tabs">
          <button class="mode-btn" :class="{ active: dialogStore.mode === 'command' }" @click="dialogStore.setMode('command'); dialogStore.showTransientHint('💬 指令模式')">指令</button>
          <button class="mode-btn" :class="{ active: dialogStore.mode === 'plan' }" @click="dialogStore.setMode('plan'); dialogStore.showTransientHint('📋 Plan模式')">Plan</button>
          <button class="mode-btn" :class="{ active: dialogStore.mode === 'teach' }" @click="dialogStore.setMode('teach'); dialogStore.showTransientHint('🎓 Teach模式')">Teach</button>
        </div>
        <div class="engine-badge" v-if="dialogStore.currentEngine">
          <span class="engine-dot"></span>
          {{ dialogStore.currentEngine }}
        </div>
      </div>

      <div class="transient-hint" v-if="dialogStore.transientHint">{{ dialogStore.transientHint }}</div>

      <div class="quick-actions">
        <!-- 2026-10-01（用户裁定）：
             · 📚 知识库 → 迁到左导航（与「管线编辑器」并列，不再挤在指令区）
             · ⚙️ 设置 → 删（主界面左上角通知旁已有设置入口）
             · ⋯ 菜单 → 删（其中「流水线」与「管线编辑器」是同一界面，属重复入口）
             · 💾 导出 → 从 ⋯ 菜单里提出来，独立成按钮放在指令下
             · ZOL → 移到本行**最右** -->
        <button class="qa-btn primary" title="导出对话" @click="exportFullDialog()">💾</button>
        <!-- 2026-10-07（用户裁定「要投入」）：系统/内部状态消息**默认隐藏**。
             实测对话区 73%（1694/2322 条）是这类机器话（★已加载27个L2宏模板 / ⚡L0 Skill… / 🤔RaaP未命中…），
             把用户真正的对话淹没。开关常显并带隐藏条数，需要排查时一键展开。 -->
        <button
          class="qa-btn"
          :class="{ active: showSystemNotices }"
          :title="showSystemNotices ? '隐藏系统消息' : `显示系统消息（已隐藏 ${hiddenNoticeCount} 条）`"
          @click="showSystemNotices = !showSystemNotices"
        >⚙️<span v-if="!showSystemNotices && hiddenNoticeCount > 0" class="qa-badge">{{ hiddenNoticeCount }}</span></button>
        <span class="qa-spacer"></span>
        <ZolWidget />
      </div>

      <div class="file-context-bar" v-if="activeFileName">
        <span class="fc-icon">📄</span>
        <span class="fc-name">{{ activeFileName }}</span>
        <span class="fc-boost" v-if="fileBoostWeight > 0">+{{ fileBoostWeight }}</span>
      </div>

      <div class="messages" ref="messagesRef">
        <div
          v-for="msg in visibleMessages"
          :key="msg.id"
          class="message"
          :class="[`msg-${msg.role}`, `msg-type-${msg.type}`]"
        >
          <div v-if="msg.role === 'system'" class="system-msg" v-html="renderContent(msg)"></div>
          <div v-else-if="msg.thoughtChain && msg.thoughtChain.length > 0" class="thought-chain">
            <div v-for="(thought, tIdx) in msg.thoughtChain" :key="tIdx" class="thought-card" :class="'tc-' + thought.phase">
              <span class="tc-icon">{{ thoughtPhaseIcon(thought.phase) }}</span>
              <span class="tc-content">{{ thought.content }}</span>
              <span v-if="thought.toolName" class="tc-tool">→ {{ thought.toolName }}</span>
            </div>
            <div v-if="msg.taskPlan" class="task-plan-card">
              <div class="tp-header">🧠 任务分析 (DAG)</div>
              <div class="tp-intent">意图：{{ msg.taskPlan.intent }}</div>
              <div class="tp-needs">需要：{{ msg.taskPlan.needs.join('、') }}</div>
              <div class="tp-steps">
                <div v-for="(s, sIdx) in msg.taskPlan.steps" :key="sIdx" class="tp-step">
                  <span class="tp-step-num">{{ s.step || sIdx + 1 }}</span>
                  <span class="tp-step-desc">{{ s.description }}</span>
                  <span class="tp-step-tool">→ {{ s.tool }}</span>
                  <span v-if="s.depends_on && s.depends_on.length > 0" class="tp-step-deps">⬅ 依赖步骤{{ s.depends_on.join(',') }}</span>
                  <span v-else class="tp-step-deps">🟢 无依赖</span>
                  <span v-if="s.fallback" class="tp-step-fallback">[备选: {{ s.fallback }}]</span>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="msg.type === 'workflow_card'" class="workflow-card-msg">
            <div class="wf-card-header">工作流卡片</div>
            <div class="wf-card-body" v-if="msg.workflowCard">
              <span v-for="nid in msg.workflowCard.nodeIds" :key="nid" class="wf-node-tag">{{ nid }}</span>
              <span class="wf-status" :class="msg.workflowCard.status">{{ msg.workflowCard.status }}</span>
            </div>
          </div>
          <div v-else-if="msg.type === 'tool_log'" class="tool-log-msg">
            <details>
              <summary class="tool-log-summary">{{ msg.content }}</summary>
              <div v-if="msg.toolLog" class="tool-log-detail">
                <div v-for="(step, idx) in msg.toolLog.steps" :key="idx" class="tool-step">
                  <span class="step-tool">{{ step.toolName }}</span>
                  <span class="step-action">{{ step.action }}</span>
                  <span class="step-result">{{ step.result }}</span>
                </div>
              </div>
            </details>
          </div>
          <div v-else class="text-msg" :class="{ 'streaming-cursor': msg.isTyping }" v-html="renderContent(msg)"></div>
          <div v-if="msg.lineage && msg.lineage.length > 0" class="lineage-panel">
            <div class="lineage-header">📊 调度血缘</div>
            <div class="lineage-steps">
              <span v-for="(l, lIdx) in msg.lineage" :key="lIdx" class="lineage-tag" :class="'ln-' + l.source">
                {{ l.step }}: {{ lineageLabel(l) }}
              </span>
            </div>
          </div>
          <div v-if="msg.fileAttachment" class="file-attachment-card" @click="onOpenAttachment(msg.fileAttachment.filePath)">
            <span class="fa-icon">📄</span>
            <span class="fa-name">{{ msg.fileAttachment.fileName }}</span>
            <span class="fa-type">.{{ msg.fileAttachment.fileType }}</span>
            <span class="fa-label">{{ msg.fileAttachment.label || '点击打开' }}</span>
          </div>
          <div v-if="msg.role === 'assistant' && msg.type === 'text' && msg.content.length > 50" class="result-actions">
            <button class="ra-btn" @click="emit('openPreview', msg)" title="预览编辑">📊</button>
            <button class="ra-btn" @click="exportAs(msg, 'docx')" title="导出为Word">📄</button>
            <button class="ra-btn" @click="exportAs(msg, 'html')" title="导出为HTML">🌐</button>
            <button class="ra-btn" @click="copyContent(msg)" title="复制内容">📋</button>
            <span class="ra-divider">|</span>
            <button class="ra-btn fb-btn fb-up" :class="{ 'fb-active': getFeedbackState(msg.id) === 'thumbs_up' }" @click="onFeedback(msg, 'thumbs_up')" title="有用">👍</button>
            <button class="ra-btn fb-btn fb-down" :class="{ 'fb-active': getFeedbackState(msg.id) === 'thumbs_down', 'fb-shake': shakingMsgId === msg.id }" @click="onFeedback(msg, 'thumbs_down')" title="无用">👎</button>
            <button class="ra-btn fb-btn fb-undo" @click="onUndo(msg)" title="撤销执行">↩️</button>
          </div>
        </div>
        <div v-if="dialogStore.isProcessing" class="message msg-assistant">
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>

      <div class="input-area">
        <div class="confirm-bar plan-confirm-bar" v-if="dialogStore.awaitingConfirmation && dialogStore.pendingPlan">
          <div class="plan-confirm-text">⏳ 等待确认执行计划...</div>
          <button class="confirm-btn yes" @click="dialogStore.confirmPlan()">✅ 确认执行</button>
          <button class="confirm-btn no" @click="dialogStore.rejectPlan()">❌ 取消</button>
        </div>

        <div class="confirm-bar intent-confirm-bar" v-if="dialogStore.awaitingIntentConfirm && dialogStore.translatedIntent">
          <div class="intent-text">🟡 Agent翻译结果：</div>
          <div class="intent-detail"><strong>意图：</strong>{{ dialogStore.translatedIntent.intent }}</div>
          <div v-if="Object.keys(dialogStore.translatedIntent.params).length > 0" class="intent-params">
            <span v-for="(val, key) in dialogStore.translatedIntent.params" :key="key" class="intent-param-tag">{{ key }}={{ val }}</span>
          </div>
          <div class="intent-actions">
            <button class="confirm-btn yes" @click="dialogStore.confirmTranslatedIntent()">✅ 是，执行</button>
            <button class="confirm-btn no" @click="dialogStore.rejectTranslatedIntent()">❌ 不对，我重新说</button>
          </div>
        </div>

        <div class="confirm-bar slot-fill-bar" v-if="dialogStore.awaitingSlotFill && dialogStore.slotClarification">
          <div class="slot-title">🔴 请填写必填参数 — {{ dialogStore.slotClarification.manifestName }}</div>
          <div v-for="slot in dialogStore.slotClarification.slots" :key="slot.name" class="slot-row">
            <label class="slot-label">{{ slot.name }}<span v-if="slot.required" class="slot-required">*</span></label>
            <input class="slot-input" v-model="slot.value" :placeholder="slot.description" />
          </div>
          <div class="slot-actions">
            <button class="confirm-btn yes" @click="onSlotSubmit()">✅ 提交并执行</button>
            <button class="confirm-btn no" @click="dialogStore.cancelSlotFill()">❌ 取消</button>
          </div>
        </div>

        <div class="confirm-bar fact-conflict-bar" v-if="dialogStore.awaitingFactResolution && dialogStore.factConflict">
          <div class="fact-title">🔴 事实一致性校验冲突</div>
          <div class="fact-conflicts">
            <div v-for="(c, i) in dialogStore.factConflict.conflicts" :key="i" class="fact-conflict-item">
              <div class="fact-diff">{{ c.diff }}</div>
              <div class="fact-compare">
                <span class="fact-source">源值: {{ c.sourceRaw }}</span>
                <span class="fact-arrow">→</span>
                <span class="fact-output">AI值: {{ c.outputRaw }}</span>
              </div>
            </div>
          </div>
          <div class="fact-actions">
            <button class="confirm-btn yes" @click="dialogStore.resolveFactConflict(true)">📝 使用源文件值</button>
            <button class="confirm-btn warn" @click="dialogStore.resolveFactConflict(false)">🤷 保留AI值</button>
            <button class="confirm-btn retry" @click="dialogStore.retryFactConflict()">🔄 重新生成</button>
          </div>
        </div>

        <div class="confirm-bar risk-confirm-bar" v-if="dialogStore.awaitingRiskConfirm && (dialogStore.writeConfirmRequest || dialogStore.riskAction)">
          <!-- O10（2026-09-22 用户裁决 B）：写类原生工具的授权三态。
               与下方高风险动作确认共用确认条，但不需要输入强确认文本——
               用户对「模型改我本机文件」的裁决应当是低摩擦的。 -->
          <template v-if="dialogStore.writeConfirmRequest">
            <div class="risk-title">⚠️ 文件写操作确认</div>
            <div class="risk-detail">
              <div class="risk-row"><span>操作</span><span>{{ dialogStore.writeConfirmRequest.operation }}</span></div>
              <div class="risk-row"><span>目标</span><span>{{ dialogStore.writeConfirmRequest.target }}</span></div>
            </div>
            <div class="risk-input-area">
              <div class="risk-hint">模型请求修改你本机的文件。选择「始终允许」后同类操作不再询问（输入 /grants 查看、/revoke-grants 撤销）。</div>
            </div>
            <div class="risk-actions">
              <button class="confirm-btn yes" @click="onWriteConfirm('once')">✅ 本次允许</button>
              <button class="confirm-btn warn" @click="onWriteConfirm('always')">🔓 始终允许此类操作</button>
              <button class="confirm-btn cancel" @click="onWriteConfirm('deny')">❌ 拒绝</button>
            </div>
          </template>
          <template v-else-if="dialogStore.riskAction">
            <div class="risk-title">⚠️ 高风险操作确认</div>
            <div class="risk-detail">
              <div class="risk-row"><span>技能</span><span>{{ dialogStore.riskAction.skill_id }}</span></div>
              <div class="risk-row"><span>操作</span><span>{{ dialogStore.riskAction.operation }}</span></div>
              <div class="risk-row"><span>目标</span><span>{{ dialogStore.riskAction.target_file }}</span></div>
              <div class="risk-row"><span>意图</span><span>{{ dialogStore.riskAction.intent }}</span></div>
            </div>
            <div class="risk-input-area">
              <div class="risk-hint">请输入"确认执行高风险操作"以继续</div>
              <input class="risk-input" v-model="riskConfirmText" placeholder="确认执行高风险操作" />
            </div>
            <div class="risk-actions">
              <button class="confirm-btn danger" :disabled="riskConfirmText !== '确认执行高风险操作'" @click="onRiskConfirm">⚠️ 确认执行</button>
              <button class="confirm-btn cancel" @click="onRiskCancel">❌ 取消</button>
            </div>
          </template>
        </div>

        <div class="confirm-bar dag-pause-bar" v-if="dialogStore.dagPaused && dialogStore.dagPausedStep != null">
          <div class="pause-title">⏸️ DAG执行暂停 — 步骤{{ dialogStore.dagPausedStep }}</div>
          <div class="pause-actions">
            <button class="confirm-btn yes" @click="dialogStore.resumeDag()">▶️ 继续执行</button>
            <button class="confirm-btn warn" @click="onTakeoverRequest">🤚 人工接管此步骤</button>
          </div>
        </div>

        <!-- P1-24：DAG 执行中提供人工暂停入口（pauseDagAtStep 此前零调用方） -->
        <div class="confirm-bar dag-pause-request" v-if="nodeStore.dagChainState.active && !dialogStore.dagPaused && nextDagPauseStepNum != null">
          <div class="pause-title">⚙️ DAG执行中 — 下一待执行步骤 {{ nextDagPauseStepNum }}</div>
          <div class="pause-actions">
            <button class="confirm-btn warn" @click="onPauseDagRequest">⏸️ 暂停在步骤{{ nextDagPauseStepNum }}</button>
          </div>
        </div>

        <div class="confirm-bar takeover-bar" v-if="dialogStore.awaitingTakeover && dialogStore.takeoverStepNum != null">
          <div class="takeover-title">🤚 人工接管步骤{{ dialogStore.takeoverStepNum }}</div>
          <textarea class="takeover-input" v-model="takeoverText" placeholder="输入此步骤的输出结果..." rows="3"></textarea>
          <div class="takeover-actions">
            <button class="confirm-btn yes" @click="onTakeoverSubmit">✅ 提交</button>
            <button class="confirm-btn cancel" @click="onTakeoverCancelShow">❌ 取消</button>
          </div>
        </div>

        <div class="context-hint" v-if="contextHint">{{ contextHint }}</div>
        <div class="attach-preview" v-if="attachedFiles.length > 0">
          <span v-for="(f, idx) in attachedFiles" :key="idx" class="attach-tag">
            {{ f.name }}
            <span class="attach-remove" @click="attachedFiles.splice(idx, 1)">x</span>
          </span>
        </div>
        <div
          class="drop-zone"
          :class="{ 'drop-active': isDragOver }"
          @dragover.prevent="isDragOver = true"
          @dragleave="isDragOver = false"
          @drop.prevent="onDrop"
        >
          <textarea
            v-model="inputText"
            placeholder="输入指令..."
            @keydown.enter.exact.prevent="onSend"
            rows="2"
          ></textarea>
          <button class="send-btn" @click="onSend" :disabled="dialogStore.isProcessing || (!inputText.trim() && attachedFiles.length === 0)">发送</button>
        </div>
        <div class="drag-hint" v-if="nodeStore.selectedNodeIds.length > 0">
          可拖入 {{ nodeStore.selectedNodeIds.length }} 个已选工具
        </div>
      </div>
      </div>

      <div class="side-panel" v-if="showPanel">
        <div v-if="showPanel === 'session'" class="session-panel">
          <div class="panel-title">💬 会话</div>
          <div class="session-toolbar">
            <button class="sess-btn sess-new" @click="onNewSession">+ 新建</button>
            <button class="sess-btn sess-upload" @click="onAttach('session')">📤 上传附件</button>
          </div>
          <div class="session-list" v-if="sessionStore.sessions.length > 0">
            <div v-for="s in sessionStore.sessions" :key="s.id" class="session-item" :class="{ active: s.id === sessionStore.activeSessionId, archived: s.status === 'archived' }" @click="onSwitchSession(s.id)" @contextmenu.prevent="onSessionContextMenu($event, s)">
              <div class="sess-info">
                <span class="sess-name" v-if="editingSessionId !== s.id">{{ s.name }}</span>
                <input v-else class="sess-rename-input" ref="renameInputRef" v-model="renameValue" @keydown.escape="finishRename(s.id)" />
                <span class="sess-meta">{{ sessionStore.countDialogRounds(s.messages) }}轮 · {{ new Date(s.updatedAt).toLocaleDateString('zh-CN') }}</span>
                <span v-if="s.knowledgeGroupId" class="sess-kb-badge" :title="'已连接: ' + getKnowledgeGroupName(s.knowledgeGroupId)">🔗 {{ getKnowledgeGroupName(s.knowledgeGroupId) }}</span>
                <span v-if="s.attachedEntryIds && s.attachedEntryIds.length > 0" class="sess-att-badge">📎{{ s.attachedEntryIds.length }}</span>
              </div>
              <div class="sess-actions" @click.stop>
                <button class="sess-act sess-del" title="删除" @click="dialogStore.deleteSession(s.id)">✕</button>
              </div>
            </div>
          </div>
          <div v-else class="mem-empty">暂无会话</div>
          <div v-if="activeSessionKnowledgeGroup" class="sess-kb-status">
            <span>知识库: {{ activeSessionKnowledgeGroup.name }}</span>
            <button class="sess-kb-disconnect" @click="onDisconnectKnowledge">断开</button>
          </div>
          <div v-else-if="sessionStore.activeSessionId" class="sess-kb-status">
            <span>未连接知识库</span>
            <select class="sess-kb-select" @change="onConnectKnowledge(($event.target as HTMLSelectElement).value)">
              <option value="">连接知识库...</option>
              <option v-for="g in knowledgeStore.knowledgeGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
          <div v-if="ctxMenu.visible" class="sess-ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
            <div class="ctx-item" @click="ctxRename">✏️ 重命名</div>
            <div class="ctx-item" @click="ctxConnectKB">🔗 连接知识库</div>
            <div class="ctx-item" @click="ctxDisconnectKB" v-if="ctxMenu.sessionId && sessionStore.sessions.find(s => s.id === ctxMenu.sessionId)?.knowledgeGroupId">🔓 断开知识库</div>
            <div class="ctx-item" @click="ctxExport('qa')">📋 导出对话式</div>
            <div class="ctx-item" @click="ctxExport('narrative')">📝 导出整合式</div>
            <div class="ctx-sep"></div>
            <div class="ctx-item ctx-warn" @click="ctxClear">🧹 清除内容</div>
          </div>
        </div>

        <div v-if="showPanel === 'settings'" class="settings-panel">
          <div class="panel-title">⚙️ 设置</div>
          <div class="set-section">
            <div class="set-row">
              <span class="set-label">主题</span>
              <button class="set-theme-btn" @click="configStore.toggleTheme">{{ configStore.theme === 'dark' ? '☀️ 浅色' : configStore.theme === 'light' ? '🌿 护眼' : '🌙 深色' }}</button>
            </div>
            <div class="set-row">
              <span class="set-label">角色</span>
              <select class="set-select" :value="configStore.currentJobRole" @change="onRoleChange">
                <option value="general">通用</option>
                <option value="hr">人力资源</option>
                <option value="finance">财务</option>
                <option value="sales">销售</option>
                <option value="legal">法务</option>
              </select>
            </div>
            <div class="set-row">
              <span class="set-label">预算</span>
              <div class="budget-mode-btns">
                <button class="budget-btn" :class="{ active: budgetMode === 'zero' }" @click="onSetBudgetMode('zero')">零预算</button>
                <button class="budget-btn" :class="{ active: budgetMode === 'economy' }" @click="onSetBudgetMode('economy')">经济</button>
                <button class="budget-btn" :class="{ active: budgetMode === 'standard' }" @click="onSetBudgetMode('standard')">标准</button>
              </div>
            </div>
            <div class="set-row" v-if="budgetMode !== 'standard'">
              <span class="set-label">本轮花费</span>
              <span class="set-val">¥{{ sessionSpentDisplay }}</span>
            </div>
          </div>
          <div class="mem-section">
            <div class="mem-section-title">偏好设置</div>
            <div class="mem-pref-list">
              <div v-for="(val, key) in memoryStore.globalMemory.preferences" :key="key" class="mem-pref-item">
                <span class="mp-key">{{ key }}</span>
                <span class="mp-val">{{ val }}</span>
              </div>
              <div v-if="Object.keys(memoryStore.globalMemory.preferences).length === 0" class="mem-empty">暂无偏好</div>
            </div>
            <div class="mem-add-row">
              <input class="mem-add-input" v-model="newPrefKey" placeholder="键..." />
              <input class="mem-add-input" v-model="newPrefVal" placeholder="值..." />
              <button class="mem-add-btn" @click="onAddPreference">+</button>
            </div>
          </div>
          <div class="mem-section">
            <div class="mem-section-title">高频术语 ({{ memoryStore.globalMemory.frequentTerms.length }})</div>
            <div class="mem-terms" v-if="memoryStore.globalMemory.frequentTerms.length > 0">
              <span v-for="term in memoryStore.globalMemory.frequentTerms.slice(0, 30)" :key="term" class="mem-term-tag">{{ term }}</span>
            </div>
            <div v-else class="mem-empty">暂无</div>
          </div>
          <div class="set-section" v-if="skillStore.installedSkills.length > 0">
            <div class="panel-subtitle">已安装技能</div>
            <div v-for="s in skillStore.installedSkills" :key="s.id" class="set-skill-item">
              <span class="ss-name">{{ s.name }}</span>
              <button class="ss-del" @click="skillStore.uninstallSkill(s.id)">✕</button>
            </div>
          </div>

          <div class="set-collapsible">
            <div class="set-collapsible-header" @click="settingsExpanded.mcp = !settingsExpanded.mcp">
              <span>🔌 MCP管理</span>
              <span class="set-collapse-arrow">{{ settingsExpanded.mcp ? '▼' : '▶' }}</span>
            </div>
            <div v-if="settingsExpanded.mcp" class="set-collapsible-body">
              <div class="mcp-conn-list" v-if="mcpStore.connections.length > 0">
                <div v-for="conn in mcpStore.connections" :key="conn.id" class="mcp-conn-item">
                  <div class="mcp-conn-header">
                    <span class="mcp-conn-dot" :class="conn.isConnected ? 'on' : 'off'"></span>
                    <span class="mcp-conn-name">{{ conn.name }}</span>
                  </div>
                  <div class="mcp-conn-meta">{{ conn.tools.length }}工具 · {{ conn.catalogId || 'HTTP' }}</div>
                  <div class="mcp-conn-actions">
                    <button class="mcp-act" v-if="!conn.isConnected" @click="onMcpStart(conn.id)">▶ 启动</button>
                    <button class="mcp-act" v-else @click="mcpStore.stopMcpProcess(conn.id)">⏹ 停止</button>
                    <button class="mcp-act" @click="mcpStore.refreshTools(conn.id)">🔄 刷新</button>
                    <button class="mcp-act mcp-del" @click="mcpStore.removeConnection(conn.id)">✕</button>
                  </div>
                  <div v-if="conn.isConnected && conn.tools.length > 0" class="mcp-tools">
                    <div v-for="tool in conn.tools" :key="tool.name" class="mcp-tool-item" :class="{ disabled: !tool.isAutoAllowed }">
                      <span class="mtp-name">{{ tool.name }}</span>
                      <button class="mtp-toggle" @click="mcpStore.toggleToolAutoAllow(conn.id, tool.name)">{{ tool.isAutoAllowed ? '✅' : '⛔' }}</button>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="mem-empty">暂无MCP连接</div>
              <div class="mcp-add-section" v-if="mcpStore.catalog.length > 0">
                <div class="panel-subtitle">MCP市场</div>
                <div v-for="item in mcpStore.catalog" :key="item.id" class="mcp-catalog-item">
                  <span class="mc-name">{{ item.name }}</span>
                  <button class="mc-install" v-if="!mcpStore.isCatalogItemInstalled(item.id)" @click="onInstallMcp(item)">安装</button>
                  <span v-else class="mc-installed">已安装</span>
                </div>
              </div>
            </div>
          </div>

          <div class="set-collapsible">
            <div class="set-collapsible-header" @click="settingsExpanded.feedback = !settingsExpanded.feedback">
              <span>⚖️ 反馈权重</span>
              <span class="set-collapse-arrow">{{ settingsExpanded.feedback ? '▼' : '▶' }}</span>
            </div>
            <div v-if="settingsExpanded.feedback" class="set-collapsible-body">
              <div class="fb-stats">
                <span class="fb-stat">记录: {{ feedbackStore.entries.length }}</span>
                <span class="fb-stat">权重项: {{ feedbackWeights.length }}</span>
                <span class="fb-stat">副作用: {{ feedbackStore.sideEffects.length }}</span>
              </div>
              <div class="fb-weight-list" v-if="feedbackWeights.length > 0">
                <div v-for="w in feedbackWeights" :key="w.skillId" class="fb-weight-item">
                  <span class="fw-id">{{ w.skillId }}</span>
                  <span class="fw-val" :class="{ positive: w.modifier > 0, negative: w.modifier < 0 }">{{ w.modifier > 0 ? '+' : '' }}{{ w.modifier.toFixed(3) }}</span>
                  <button class="fw-reset" @click="feedbackStore.adjustWeight(w.skillId, -w.modifier)">归零</button>
                </div>
              </div>
              <div v-else class="mem-empty">暂无权重数据</div>
              <div class="fb-actions">
                <button class="fb-act-btn" @click="onDecayAll">⏳ 衰减全部</button>
                <button class="fb-act-btn" @click="onClearFeedbackCache">🗑️ 清缓存</button>
              </div>
            </div>
          </div>

          <div class="set-collapsible">
            <div class="set-collapsible-header" @click="settingsExpanded.cache = !settingsExpanded.cache">
              <span>🗃️ 路由缓存</span>
              <span class="set-collapse-arrow">{{ settingsExpanded.cache ? '▼' : '▶' }}</span>
            </div>
            <div v-if="settingsExpanded.cache" class="set-collapsible-body">
              <div class="cache-stats">
                <div class="cs-row"><span>缓存条数</span><span>{{ cacheStats.size }}</span></div>
                <div class="cs-row"><span>命中</span><span class="cs-hit">{{ cacheStats.hits }}</span></div>
                <div class="cs-row"><span>未命中</span><span class="cs-miss">{{ cacheStats.misses }}</span></div>
                <div class="cs-row" v-if="cacheStats.hits + cacheStats.misses > 0"><span>命中率</span><span>{{ (cacheStats.hits / (cacheStats.hits + cacheStats.misses) * 100).toFixed(1) }}%</span></div>
              </div>
              <button class="cache-clear-btn" @click="onClearRouteCache">🗑️ 清除缓存</button>
            </div>
          </div>

          <div class="set-collapsible">
            <div class="set-collapsible-header" @click="settingsExpanded.timeline = !settingsExpanded.timeline">
              <span>📊 执行记录</span>
              <span class="set-collapse-arrow">{{ settingsExpanded.timeline ? '▼' : '▶' }}</span>
            </div>
            <div v-if="settingsExpanded.timeline" class="set-collapsible-body">
              <div class="timeline-toolbar" v-if="workflowLogStore.logs.length > 0">
                <button class="tl-tool-btn" @click="exportWorkflowLogs">📋 导出</button>
                <button class="tl-tool-btn" @click="clearWorkflowLogs">🗑️ 清空</button>
              </div>
              <div class="timeline-list" v-if="workflowLogStore.logs.length > 0">
                <div v-for="log in workflowLogStore.logs.slice(0, 20)" :key="log.id" class="timeline-entry" @click="selectTimelineLog(log.id)" :class="{ active: selectedTimelineId === log.id }">
                  <div class="timeline-header">
                    <span class="timeline-status">{{ log.status === 'completed' ? '✅' : log.status === 'failed' ? '❌' : '🔄' }}</span>
                    <span class="timeline-name">{{ log.name }}</span>
                  </div>
                  <div class="timeline-meta">{{ log.nodes.length }}步 · {{ new Date(log.startedAt).toLocaleTimeString('zh-CN') }}</div>
                </div>
              </div>
              <div v-else class="mem-empty">暂无执行记录</div>
              <div v-if="selectedTimelineLog" class="timeline-detail">
                <div class="panel-subtitle">步骤详情</div>
                <div class="timeline-steps">
                  <div v-for="(node, idx) in selectedTimelineLog.nodes" :key="idx" class="timeline-step" :class="{ active: timelineStepIdx === idx }" @click="timelineStepIdx = idx">
                    <span class="step-status">{{ node.status === 'completed' ? '✅' : node.status === 'failed' ? '❌' : node.status === 'running' ? '🔄' : '⏳' }}</span>
                    <span class="step-tool">{{ node.toolId }}</span>
                  </div>
                </div>
                <div v-if="selectedSnapshot" class="timeline-io">
                  <div class="detail-sublabel" @click="timelineInputExpanded = !timelineInputExpanded">📥 输入 {{ timelineInputExpanded ? '▼' : '▶' }}</div>
                  <pre v-if="timelineInputExpanded" class="detail-json">{{ selectedSnapshot.input }}</pre>
                  <div class="detail-sublabel" @click="timelineOutputExpanded = !timelineOutputExpanded">📤 输出 {{ timelineOutputExpanded ? '▼' : '▶' }}</div>
                  <pre v-if="timelineOutputExpanded" class="detail-json">{{ selectedSnapshot.output }}</pre>
                </div>
              </div>
            </div>
          </div>

          <div class="set-section">
            <div class="panel-subtitle">DAG检查点</div>
            <div class="cp-list" v-if="checkpointList.length > 0">
              <div v-for="cp in checkpointList" :key="cp.id" class="cp-item">
                <div class="cp-header">
                  <span class="cp-id">{{ cp.manifestId }}</span>
                  <span v-if="resumableIds.has(cp.id)" class="cp-badge" title="未完成且未过期，可继续">可恢复</span>
                  <span class="cp-progress">{{ Object.keys(cp.completedResults).length }}/{{ cp.totalSteps }}</span>
                </div>
                <div class="cp-meta">{{ new Date(cp.updatedAt).toLocaleString('zh-CN') }}</div>
                <div class="cp-actions">
                  <button class="cp-btn" @click="onRestoreCheckpoint(cp.id)">🔄 恢复</button>
                  <button class="cp-btn cp-del" @click="onRemoveCheckpoint(cp.id)">✕</button>
                </div>
              </div>
            </div>
            <div v-else class="mem-empty">暂无检查点</div>
          </div>
        </div>

        <div v-if="showPanel === 'macro'" class="macro-create-panel">
          <div class="panel-title">⚙️ 自定义宏模板</div>
          <div class="macro-form">
            <label class="macro-label">名称</label>
            <input v-model="macroName" class="macro-input" placeholder="例：数据分析报告" />
            <label class="macro-label">关键词(逗号分隔)</label>
            <input v-model="macroKeywords" class="macro-input" placeholder="例：数据分析,报告,统计" />
            <label class="macro-label">步骤(每行: 工具名|描述|依赖步骤号)</label>
            <textarea v-model="macroSteps" class="macro-textarea" placeholder="knowledge_search|检索相关知识|&#10;llm_generate|AI生成分析|1&#10;shell_exec|生成报告文件|2" rows="5"></textarea>
            <label class="macro-label">提示词模板(用于llm_generate步骤)</label>
            <textarea v-model="macroPrompt" class="macro-textarea" placeholder="你是一名数据分析师。根据以下数据生成分析报告：{{step_1_result}}" rows="3"></textarea>
            <button class="macro-save-btn" @click="saveMacroTemplate">保存模板</button>
            <div v-if="macroSaveMsg" class="macro-save-msg" :class="{ error: macroSaveMsg.includes('失败') }">{{ macroSaveMsg }}</div>
          </div>
          <div class="macro-existing" v-if="customMacros.length > 0">
            <div class="panel-subtitle">已有自定义模板</div>
            <div v-for="m in customMacros" :key="m.identity.id" class="macro-item">
              <span class="macro-item-name">{{ m.identity.name }}</span>
              <button class="macro-btn-sm" @click="exportMacro(m)" title="导出JSON">📋</button>
              <button class="macro-del-btn" @click="deleteMacro(m.identity.id)">✕</button>
            </div>
            <div class="macro-import-row">
              <button class="macro-save-btn" @click="triggerImportMacro" style="font-size:11px;padding:4px 10px">📥 导入蓝图</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify'
import { ref, computed, nextTick, watch, onMounted, onUnmounted, reactive } from 'vue'
import { useDialogStore } from '@/domains/dialog'
import { renderToEmailHtml } from '@/domains/dialog'
import { useNodeStore } from '@/domains/node'
import { getRouteCacheStats, clearRouteCache } from '@/domains/node'
import { getFileContext, setActiveFile } from '@/domains/node'
import { useMcpStore } from '@/domains/mcp'
import { useApiStore } from '@/domains/api'
import { useDebugStore } from '@/domains/debug'
import { useFeedbackStore, computeQueryFingerprint } from '@/domains/feedback'
import { useSessionStore } from '@/domains/app'
import { useMemoryStore } from '@/domains/memory'
import { useKnowledgeStore } from '@/domains/knowledge'
import { ingestFile } from '@/domains/knowledge'
import { useSkillStore } from '@/domains/app'
import { useConfigStore } from '@/domains/config'
import { DialogMessage, ThoughtStep, TaskPlan, L2ToolManifest, McpCatalogItem, JobRole, BudgetMode } from '@/models'
import { usePipelineStore } from '@/domains/pipeline'
import { getAllCheckpoints, removeCheckpoint, getCheckpoint, getIncompleteCheckpoints } from '@/domains/pipeline'
import { saveCustomManifest, loadCustomManifests, removeCustomManifest } from '@/data/l2Manifests'
import { useWorkflowLogStore } from '@/domains/app'
import { getBudgetMode, setBudgetMode as setBudgetModeFn, getSessionSpent } from '@/services/tokenBudget'
import ZolWidget from '@/components/ZolWidget.vue'
import { globalBus } from '@/kernel/bus'

const dialogStore = useDialogStore()
const nodeStore = useNodeStore()
const mcpStore = useMcpStore()
const apiStore = useApiStore()
const debugStore = useDebugStore()
const feedbackStore = useFeedbackStore()
const pipelineStore = usePipelineStore()
const sessionStore = useSessionStore()
const memoryStore = useMemoryStore()
const knowledgeStore = useKnowledgeStore()
const skillStore = useSkillStore()
const configStore = useConfigStore()

// R16 工作台：docked=true 时以静态布局嵌入中栏（无 fixed 定位/拖拽/折叠），星图模式默认 false
const props = defineProps<{ docked?: boolean }>()

const emit = defineEmits<{
  openMcp: []
  cameraFlyTo: [nodeId: string]
  panelWidthChanged: [width: number]
  openPreview: [msg: DialogMessage]
}>()

const isCollapsed = ref(false)
const inputText = ref('')
const messagesRef = ref<HTMLDivElement>()
const isDragOver = ref(false)
const attachedFiles = ref<{ name: string; content: string; size: number }[]>([])
const MAX_ATTACH_SIZE = 200000
const shakingMsgId = ref('')
const feedbackStates = ref<Record<string, 'thumbs_up' | 'thumbs_down'>>({})
const riskConfirmText = ref('')
const takeoverText = ref('')
const panelWidth = ref(configStore.config.dialogPanelWidth ?? 460)
const isResizing = ref(false)
const showPanel = ref('')
/** 2026-10-01：左导航「会话级操作」事件订阅的释放函数 */
let uiSessionPanelDisposer: (() => void) | null = null
const pipelineNodeIds = ref<string[]>([])
const macroName = ref('')
const macroKeywords = ref('')
const macroSteps = ref('')
const macroPrompt = ref('')
const macroSaveMsg = ref('')
const customMacros = ref<L2ToolManifest[]>(loadCustomManifests())
const workflowLogStore = useWorkflowLogStore()
const selectedTimelineId = ref<string | null>(null)
const timelineStepIdx = ref(0)
const timelineInputExpanded = ref(false)
const timelineOutputExpanded = ref(false)

const editingSessionId = ref('')
const renameValue = ref('')
const ctxMenu = reactive({ visible: false, x: 0, y: 0, sessionId: '', sessionName: '' })
const newPrefKey = ref('')
const newPrefVal = ref('')

const activeFileName = ref<string | null>(null)
const fileBoostWeight = ref(0)

/**
 * 2026-10-07（用户裁定「要投入」）：对话区默认**只显示用户与助手的对话**。
 * 实测 `dialog.messages` 共 2322 条，其中 system/system_notice 占 1694 条（73%）——
 * 用户要看的回答被埋在里面。系统消息仍在 store 里（不影响上下文/记忆/审计），只是默认不渲染。
 */
const showSystemNotices = ref(false)
const hiddenNoticeCount = computed(() => dialogStore.messages.filter(m => m.role === 'system').length)
const visibleMessages = computed(() =>
  showSystemNotices.value ? dialogStore.messages : dialogStore.messages.filter(m => m.role !== 'system')
)

const cacheStats = ref({ size: 0, hits: 0, misses: 0 })
const checkpointList = ref<Array<{ id: string; manifestId: string; completedResults: Record<number, string>; failedSteps: number[]; skipSteps: number[]; totalSteps: number; updatedAt: number }>>([])
// 2026-09-25（机制体检）：resume 候选集合——供列表标出「可恢复」（此前 getIncompleteCheckpoints 零消费者）
const resumableIds = ref<Set<string>>(new Set())
const pipeSource = ref<'l1' | 'skill' | 'mcp'>('l1')
const dagDeps = ref<number[][]>([])
const dagDragIdx = ref<number | null>(null)
const pipeBindSessionId = ref('')
const pipeUploadTarget = ref(false)
const pipeUploadDest = ref<'knowledge' | 'pipeline'>('knowledge')
const settingsExpanded = reactive({ mcp: false, feedback: false, cache: false, timeline: false })
const budgetMode = ref<BudgetMode>(getBudgetMode())
const sessionSpentDisplay = computed(() => getSessionSpent().toFixed(4))

function onSetBudgetMode(mode: BudgetMode) {
  setBudgetModeFn(mode)
  budgetMode.value = mode
}

const effectiveMinWidth = computed(() => showPanel.value ? 440 : 260)

watch([panelWidth, isCollapsed], () => {
  const effectiveWidth = isCollapsed.value ? 0 : panelWidth.value
  document.documentElement.style.setProperty('--dialog-panel-width', `${isCollapsed.value ? 24 : panelWidth.value}px`)
  emit('panelWidthChanged', effectiveWidth)
}, { immediate: true })

// 2026-10-01（用户裁定）：知识库管理在**独立窗口**中打开，不再是指令区右栏的覆盖层
function openKnowledgeWindow() {
  window.electronAPI?.openKnowledgeWindow?.()
}

const selectedTimelineLog = computed(() => {
  if (!selectedTimelineId.value) return null
  return workflowLogStore.logs.find(l => l.id === selectedTimelineId.value) || null
})

const feedbackWeights = computed(() => Array.from(feedbackStore.weights.values()))

const selectedSnapshot = computed(() => {
  const log = selectedTimelineLog.value
  if (!log) return null
  const node = log.nodes[timelineStepIdx.value]
  if (!node) return null
  return log.ioSnapshots.find(s => s.toolId === node.toolId) || null
})

function selectTimelineLog(id: string) {
  selectedTimelineId.value = id
  timelineStepIdx.value = 0
  timelineInputExpanded.value = false
  timelineOutputExpanded.value = false
}

const l1Nodes = computed(() => nodeStore.nodes.filter(n => n.level === 'L1'))

const currentPipelineSessionName = computed(() => {
  const pipelines = pipelineStore.pipelines
  if (pipelines.length === 0) return ''
  const lastPipeline = pipelines[pipelines.length - 1]
  if (!lastPipeline.sessionId) return ''
  const session = sessionStore.sessions.find(s => s.id === lastPipeline.sessionId)
  return session?.name || ''
})

const activeSessionKnowledgeGroup = computed(() => {
  const session = sessionStore.activeSession
  if (!session || !session.knowledgeGroupId) return null
  return knowledgeStore.knowledgeGroups.find(g => g.id === session.knowledgeGroupId) || null
})

function startResize(e: MouseEvent) {
  isResizing.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value
  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    const minW = effectiveMinWidth.value
    panelWidth.value = Math.max(minW, Math.min(800, startWidth + delta))
  }
  const onUp = () => {
    isResizing.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const contextHint = computed(() => {
  const parts: string[] = []
  const node = nodeStore.selectedNode
  if (node) {
    parts.push(`当前选中: ${node.name}(${node.level}) | MCP: ${mcpStore.mcpToolsAsNodes.length}个`)
  }
  if (attachedFiles.value.length > 0) {
    parts.push(`${attachedFiles.value.length}个附件待发送`)
  }
  return parts.join(' | ')
})

watch(() => dialogStore.messages.length, async () => {
  await nextTick()
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
})

// 2026-09-25：这里原本挂着一个"流式输出时自动滚到底"的 watcher，监视
// dialogStore.streamingMessageId——但 dialogStore 从来没有这个成员 ⇒ 它恒返回 null，
// 是一段永不生效的死代码（类型检查报了 4 轮 TS2339，此前被 typecheck 脚本的 TS6305 掩蔽）。
// 整块移除。若确实要"边流边滚"，正确做法是先在 dialogStore 里真正维护 streamingMessageId。
watch(() => showPanel.value, async (val) => {
  if (val === 'settings') {
    await loadCheckpoints()
  }
  if (val === 'cache') {
    cacheStats.value = getRouteCacheStats()
  }
})

function onDrop() {
  isDragOver.value = false
  const nodes = nodeStore.addSelectedToDialog()
  if (nodes.length === 0) return
  const names = nodes.map(n => n.name).join(' + ')
  dialogStore.addSystemNotice(`已将 ${nodes.length} 个工具加入编排: ${names}`)
  for (let i = 0; i < nodes.length - 1; i++) {
    nodeStore.addFlowPath(nodes[i].id, nodes[i + 1].id)
  }
  for (const n of nodes) {
    dialogStore.addToolLogMessage({
      toolName: n.name,
      steps: [{ toolId: n.id, toolName: n.name, action: '加入编排队列', result: '待执行', durationMs: 0 }],
      totalTimeMs: 0
    })
  }
  nodeStore.clearNodeSelection()
}

function onSlotSubmit() {
  const sc = dialogStore.slotClarification
  if (!sc) return
  const filled: Record<string, string> = {}
  for (const slot of sc.slots) {
    filled[slot.name] = slot.value
  }
  const missing = sc.slots.filter(s => s.required && !filled[s.name])
  if (missing.length > 0) {
    dialogStore.addSystemNotice(`⚠️ 必填项未填：${missing.map(s => s.name).join('、')}`)
    return
  }
  dialogStore.submitSlotFill(filled)
}

function onSend() {
  // P0-C3：Enter 路径此前无禁用（发送按钮有 :disabled 而 keydown.enter 没有），
  // 处理中可并发第二条 sendMessage 造成管线交错——此处统一守卫
  if (dialogStore.isProcessing) return
  if (!inputText.value.trim() && attachedFiles.value.length === 0) return
  let fullContent = inputText.value.trim()
  if (fullContent === '/debug') {
    inputText.value = ''
    if (debugStore.enabled) {
      debugStore.deactivate()
      dialogStore.addSystemNotice('🔍 调试模式已关闭')
    } else {
      debugStore.activate()
      debugStore.updateEnvironment({
        model: apiStore.config.activeModel || '',
        provider: apiStore.config.activeProviderId || '',
        apiReachable: apiStore.isReady,
        nodeCount: nodeStore.nodes.length,
        manifestCount: Object.keys(nodeStore.l2Manifests).length
      })
      dialogStore.addSystemNotice('🔍 调试模式已开启 — 输入 /debug 关闭')
      window.electronAPI?.openDebugWindow()
    }
    return
  }
  if (attachedFiles.value.length > 0) {
    const fileSection = attachedFiles.value.map(f =>
      `=== 文件: ${f.name} (${(f.size / 1024).toFixed(1)}KB) ===\n${f.content}`
    ).join('\n\n')
    fullContent = fullContent
      ? `${fullContent}\n\n---\n以下是用户提供的附件内容：\n\n${fileSection}`
      : `以下是用户提供的附件内容：\n\n${fileSection}`
    attachedFiles.value = []
  }
  dialogStore.sendMessage(fullContent)
  inputText.value = ''
}

function onAttach(target: 'session' | 'pipeline' | 'knowledge-base') {
  pipeUploadTarget.value = target === 'pipeline'
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.md,.txt,.json,.csv,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.h,.yaml,.yml,.toml,.ini,.cfg,.log,.sql,.sh,.bat,.ps1,.env,.gitignore,.editorconfig,.prettierrc,.eslintrc'
  input.onchange = async () => {
    const files = input.files
    if (!files || files.length === 0) return
    const readPromises = Array.from(files).map(file => {
      return new Promise<{ name: string; content: string; size: number; entryId?: string }>((resolve) => {
        const reader = new FileReader()
        reader.onload = async () => {
          const text = reader.result as string
          try {
            let ingestTarget: { type: 'global' | 'session' | 'pipeline' | 'group'; ownerId?: string }
            if (target === 'session') {
              const session = sessionStore.activeSession
              if (session?.knowledgeGroupId) {
                ingestTarget = { type: 'group', ownerId: session.knowledgeGroupId }
              } else {
                ingestTarget = { type: 'session', ownerId: session?.id }
              }
            } else if (target === 'pipeline') {
              if (pipeUploadDest.value === 'knowledge') {
                const lastPipeline = pipelineStore.pipelines[pipelineStore.pipelines.length - 1]
                ingestTarget = lastPipeline?.knowledgeGroupId
                  ? { type: 'group', ownerId: lastPipeline.knowledgeGroupId }
                  : { type: 'global' }
              } else {
                const lastPipeline = pipelineStore.pipelines[pipelineStore.pipelines.length - 1]
                ingestTarget = { type: 'pipeline', ownerId: lastPipeline?.id }
              }
            } else {
              ingestTarget = { type: 'global' }
            }
            const entry = await ingestFile(file, ingestTarget)
            if (target === 'session' && sessionStore.activeSessionId) {
              sessionStore.addSessionEntry(sessionStore.activeSessionId, entry.id)
              if (sessionStore.activeSession?.knowledgeGroupId) {
                knowledgeStore.addSharedEntryToGroup(sessionStore.activeSession.knowledgeGroupId, entry.id)
              }
            } else if (target === 'pipeline' && pipeUploadDest.value === 'pipeline') {
              const lastPipeline = pipelineStore.pipelines[pipelineStore.pipelines.length - 1]
              if (lastPipeline) pipelineStore.addPipelineEntry(lastPipeline.id, entry.id)
            }
            const targetLabel = target === 'session' ? (sessionStore.activeSession?.knowledgeGroupId ? '知识库+会话' : '会话')
              : target === 'pipeline' ? (pipeUploadDest.value === 'knowledge' ? '知识库' : '流水线')
              : '知识库'
            dialogStore.addSystemNotice(`[上传] ${file.name} → ${targetLabel} (${entry.chunks}块)`)
            resolve({
              name: file.name,
              content: text.length > MAX_ATTACH_SIZE ? text.substring(0, MAX_ATTACH_SIZE) + '\n... (截断)' : text,
              size: file.size,
              entryId: entry.id
            })
          } catch {
            resolve({ name: file.name, content: `(读取失败)`, size: 0 })
          }
        }
        reader.onerror = () => {
          resolve({ name: file.name, content: `(读取失败)`, size: 0 })
        }
        reader.readAsText(file)
      })
    })
    const results = await Promise.all(readPromises)
    attachedFiles.value.push(...results.map(r => ({ name: r.name, content: r.content, size: r.size })))
    const names = results.map(r => r.name).join(', ')
    dialogStore.addSystemNotice(`已附加 ${results.length} 个文件: ${names}`)
  }
  input.click()
}



function renderContent(msg: DialogMessage): string {
  if (msg.type === 'system_notice') {
    return DOMPurify.sanitize(`<span class="system-notice-text">${escapeHtml(msg.content)}</span>`)
  }
  let html = escapeHtml(msg.content)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\n/g, '<br/>')
  return DOMPurify.sanitize(html)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function exportAs(msg: DialogMessage, format: 'docx' | 'html') {
  const content = msg.content
  const home = await window.electronAPI?.resolvePath('%USERPROFILE%') || 'C:\\Users\\Default'
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (format === 'html') {
    const html = renderToEmailHtml(content)
    const filePath = `${home}\\Desktop\\holo-export-${ts}.html`
    const result = await window.electronAPI?.fileWrite({ filePath, content: html, encoding: 'utf8' })
    if (result?.success) {
      dialogStore.addSystemNotice('[导出] ✅ 已导出 HTML 到桌面')
      await window.electronAPI?.openFilePath(filePath)
    } else {
      dialogStore.addSystemNotice('❌ 导出HTML失败')
    }
  } else {
    const fileName = `holo-export-${ts}.docx`
    const filePath = `${home}\\Desktop\\${fileName}`
    try {
      const result = await window.electronAPI?.createDocx({ filePath, content, title: 'HoloStarmap 导出' })
      if (result?.success) {
        dialogStore.addSystemNotice('[导出] ✅ 已导出 docx 到桌面')
        await window.electronAPI?.openFilePath(filePath)
      } else {
        dialogStore.addSystemNotice('❌ 导出docx失败')
      }
    } catch (err) {
      const errStr = String(err)
      dialogStore.addSystemNotice(`❌ 导出失败（${errStr.includes('permission') ? '权限不足' : '执行异常'}）`)
    }
  }
}

async function copyContent(msg: DialogMessage) {
  try {
    await navigator.clipboard.writeText(msg.content)
    dialogStore.addSystemNotice('[美化师] 内容已复制到剪贴板')
  } catch {
    dialogStore.addSystemNotice('[美化师] 复制失败')
  }
}

async function onOpenAttachment(filePath: string) {
  if (!window.electronAPI?.openFilePath) {
    dialogStore.addSystemNotice('❌ 无法打开文件')
    return
  }
  const result = await window.electronAPI.openFilePath(filePath)
  if (!result.success) {
    dialogStore.addSystemNotice('❌ 打开文件失败')
  }
}

function getFeedbackState(msgId: string): 'thumbs_up' | 'thumbs_down' | undefined {
  return feedbackStates.value[msgId]
}

function onFeedback(msg: DialogMessage, action: 'thumbs_up' | 'thumbs_down') {
  const prev = feedbackStates.value[msg.id]
  if (prev === action) return
  feedbackStates.value[msg.id] = action
  const fp = computeQueryFingerprint(msg.content.substring(0, 200))
  feedbackStore.recordFeedback(fp, msg.id, action, [], '', dialogStore.lastDecisionContext ?? undefined)
  if (action === 'thumbs_down') {
    shakingMsgId.value = msg.id
    setTimeout(() => { shakingMsgId.value = '' }, 500)
  }
}

function onUndo(msg: DialogMessage) {
  const latest = feedbackStore.sideEffects.length > 0
    ? feedbackStore.sideEffects[feedbackStore.sideEffects.length - 1]
    : null
  if (latest) {
    feedbackStore.undoExecution(latest.executionId)
    feedbackStates.value[msg.id] = 'thumbs_down'
    dialogStore.addSystemNotice('[反馈] 已撤销执行，相关文件已移至回收站')
  } else {
    dialogStore.addSystemNotice('[反馈] 未找到可撤销的执行记录')
  }
}

function onRiskConfirm() {
  dialogStore.resolveRiskConfirm(true)
  riskConfirmText.value = ''
}

function onRiskCancel() {
  dialogStore.resolveRiskConfirm(false)
  riskConfirmText.value = ''
}

// O10（2026-09-22 用户裁决 B）：写类工具授权的三态裁决入口。
// 'always' 的持久化由调用方（macroExecutor 侧）按裁决结果落盘，UI 只表达意图。
function onWriteConfirm(decision: 'deny' | 'once' | 'always') {
  dialogStore.resolveWriteConfirm(decision)
}

function onTakeoverRequest() {
  takeoverText.value = ''
  if (dialogStore.dagPausedStep != null) {
    dialogStore.requestTakeover(dialogStore.dagPausedStep)
  }
}

// P1-24：DAG 人工暂停入口。暂停目标取第一个 pending 步骤——
// macroExecutor 在单就绪步骤执行前轮询暂停状态，已进入 running 的步骤无法中断。
const nextDagPauseStepNum = computed(() => {
  const steps = nodeStore.dagChainState.steps
  const next = steps.find(s => s.status === 'pending')
  return next ? next.stepNum : null
})

function onPauseDagRequest() {
  if (nextDagPauseStepNum.value == null) return
  const manifestId = nodeStore.dagChainState.steps[0]?.nodeId || ''
  dialogStore.pauseDagAtStep(nextDagPauseStepNum.value, manifestId)
}

function onTakeoverSubmit() {
  dialogStore.submitTakeover(takeoverText.value)
  takeoverText.value = ''
}

function onTakeoverCancelShow() {
  dialogStore.cancelTakeover()
  takeoverText.value = ''
}

function exportFullDialog() {
  const msgs = dialogStore.messages.filter(m => m.role === 'user' || m.role === 'assistant')
  if (msgs.length === 0) {
    dialogStore.addSystemNotice('[导出] 没有可导出的对话')
    return
  }
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`
  let md = `# HoloStarmap 对话导出\n\n导出时间: ${now.toLocaleString('zh-CN')}\n\n---\n\n`
  for (const msg of msgs) {
    const role = msg.role === 'user' ? '👤 用户' : '🤖 助手'
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN') : ''
    md += `## ${role} ${time ? '(' + time + ')' : ''}\n\n${msg.content}\n\n`
    // 2026-09-25：原有一段读 `msg.toolCalls` 的导出逻辑，但对话消息类型里没有 toolCalls
    // 字段、也没有任何代码往里写过它 ⇒ 恒为 undefined 的死分支。移除以消除假接口。
  }
  md += `---\n\n*共 ${msgs.length} 条消息 | 由 HoloStarmap 导出*\n`
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `holo-dialog-${dateStr}.md`
  a.click()
  URL.revokeObjectURL(url)
  dialogStore.addSystemNotice(`[导出] ✅ 已导出 ${msgs.length} 条对话到 holo-dialog-${dateStr}.md`)
}

function saveMacroTemplate() {
  if (!macroName.value.trim()) { macroSaveMsg.value = '请输入名称'; return }
  if (!macroSteps.value.trim()) { macroSaveMsg.value = '请输入步骤'; return }
  const stepLines = macroSteps.value.trim().split('\n').filter(l => l.trim())
  const steps = stepLines.map((line, idx) => {
    const parts = line.split('|').map(s => s.trim())
    const tool = parts[0] || 'llm_generate'
    const desc = parts[1] || `步骤${idx + 1}`
    const deps = parts[2] ? parts[2].split(',').map(Number).filter(n => !isNaN(n) && n > 0) : (idx > 0 ? [idx] : [])
    const params: Record<string, unknown> = {}
    if (tool === 'llm_generate') {
      params.prompt = macroPrompt.value || '请根据上下文完成任务'
    }
    // 2026-09-25：L2DagStep.expectedOutput 是必填字段，原先自建宏漏了它 ⇒ 类型不兼容
    // （TS2322，此前被 typecheck 脚本的 TS6305 掩蔽）。用户在手写步骤行里没给输出描述，
    // 就用步骤描述兜底（官方 manifest 的每一步也都有这个字段）。
    return { step: idx + 1, description: desc, tool, depends_on: deps, params, modelTier: 'standard' as const, expectedOutput: desc }
  })
  const id = `l2-custom-${macroName.value.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`
  const manifest: L2ToolManifest = {
    // 2026-09-25：author 原写 'custom'，但 Author 联合类型是 'user'|'official'|'community'——
    // 用户自建宏语义上正是 'user'，改用类型里已有的取值（而不是放宽联合类型）。
    identity: { id, name: macroName.value, version: '1.0.0', author: 'user', createdAt: Date.now(), updatedAt: Date.now(), templateId: id },
    visual: { baseColor: '#ff9944', ringStyle: 'dashed', badges: ['custom'], hoverLabel: macroName.value, anchorGlow: '#ff8833', upgradeGlow: '#ffcc44' },
    routing: { keywords: macroKeywords.value.split(',').map(k => k.trim()).filter(Boolean), targetRoles: ['general'], requiredL1: [], inputType: 'text', retrievalSummary: macroName.value, userSummary: macroName.value, confidenceThreshold: 0.5 },
    execution: { mode: 'macro', dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 }, paramMapping: { slots: [], bindings: [] } },
    cacheMeta: { estimatedTokenSaving: 1000, avgExecutionTime: 10000, cacheable: false, cacheTTL: 0 }
  }
  saveCustomManifest(manifest)
  customMacros.value = loadCustomManifests()
  macroSaveMsg.value = `✅ 已保存模板: ${macroName.value}`
  macroName.value = ''
  macroKeywords.value = ''
  macroSteps.value = ''
  macroPrompt.value = ''
  setTimeout(() => { macroSaveMsg.value = '' }, 3000)
}

function deleteMacro(id: string) {
  removeCustomManifest(id)
  customMacros.value = loadCustomManifests()
}

function exportMacro(m: L2ToolManifest) {
  const json = JSON.stringify(m, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${m.identity.id}.blueprint.json`
  a.click()
  URL.revokeObjectURL(url)
}

function triggerImportMacro() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const m = JSON.parse(reader.result as string) as L2ToolManifest
        if (!m.identity?.id || !m.execution?.dagPlan) throw new Error('格式不正确')
        saveCustomManifest(m)
        customMacros.value = loadCustomManifests()
        dialogStore.addSystemNotice(`📥 已导入蓝图: ${m.identity.name}`)
      } catch (e) {
        dialogStore.addSystemNotice(`❌ 导入失败: ${(e as Error).message}`)
      }
    }
    reader.readAsText(file)
  }
  input.click()
}

function togglePipelineNode(node: { id: string; name?: string }) {
  const idx = pipelineNodeIds.value.indexOf(node.id)
  if (idx >= 0) {
    pipelineNodeIds.value.splice(idx, 1)
    dagDeps.value.splice(idx, 1)
    for (const deps of dagDeps.value) {
      const depIdx = deps.indexOf(idx)
      if (depIdx >= 0) deps.splice(depIdx, 1)
      for (let i = 0; i < deps.length; i++) {
        if (deps[i] > idx) deps[i]--
      }
    }
  } else {
    pipelineNodeIds.value.push(node.id)
    dagDeps.value.push([])
  }
}

function removePipelineNode(idx: number) {
  pipelineNodeIds.value.splice(idx, 1)
  dagDeps.value.splice(idx, 1)
  for (const deps of dagDeps.value) {
    const depIdx = deps.indexOf(idx)
    if (depIdx >= 0) deps.splice(depIdx, 1)
    for (let i = 0; i < deps.length; i++) {
      if (deps[i] > idx) deps[i]--
    }
  }
}

function getNodeName(id: string): string {
  const node = nodeStore.nodes.find(n => n.id === id)
  if (node) return node.name
  const skill = skillStore.installedSkills.find(s => s.id === id)
  if (skill) return skill.name
  const mcp = mcpStore.mcpToolsAsNodes.find(m => m.id === id)
  if (mcp) return mcp.name
  return id
}

function toggleDep(nodeIdx: number, depIdx: number) {
  const deps = dagDeps.value[nodeIdx]
  if (!deps) return
  const pos = deps.indexOf(depIdx)
  if (pos >= 0) {
    deps.splice(pos, 1)
  } else {
    deps.push(depIdx)
  }
}

function onAddDep(nodeIdx: number) {
  const deps = dagDeps.value[nodeIdx]
  if (!deps) return
  for (let i = 0; i < nodeIdx; i++) {
    if (!deps.includes(i)) {
      deps.push(i)
      return
    }
  }
}

function onAutoArrange() {
  for (let i = 0; i < pipelineNodeIds.value.length; i++) {
    if (!dagDeps.value[i]) dagDeps.value[i] = []
    dagDeps.value[i] = i > 0 ? [i - 1] : []
  }
  dialogStore.addSystemNotice('🧠 已自动排列依赖: 串行顺序')
}

function onDagDragStart(idx: number, e: DragEvent) {
  dagDragIdx.value = idx
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDagDrop(targetIdx: number) {
  if (dagDragIdx.value === null || dagDragIdx.value === targetIdx) return
  const from = dagDragIdx.value
  const id = pipelineNodeIds.value.splice(from, 1)[0]
  const deps = dagDeps.value.splice(from, 1)[0] || []
  pipelineNodeIds.value.splice(targetIdx, 0, id)
  dagDeps.value.splice(targetIdx, 0, deps.map(d => {
    if (d === from) return targetIdx
    if (from < targetIdx) {
      return d > from && d <= targetIdx ? d - 1 : d
    } else {
      return d >= targetIdx && d < from ? d + 1 : d
    }
  }))
  dagDragIdx.value = null
}

function onClearPipeline() {
  pipelineNodeIds.value = []
  dagDeps.value = []
}

function onPipeBindSession() {
  if (!pipeBindSessionId.value) return
  const pipelines = pipelineStore.pipelines
  if (pipelines.length === 0) return
  const lastPipeline = pipelines[pipelines.length - 1]
  pipelineStore.bindSession(lastPipeline.id, pipeBindSessionId.value)
  const session = sessionStore.sessions.find(s => s.id === pipeBindSessionId.value)
  dialogStore.showTransientHint(`🔗 流水线已绑定会话: ${session?.name || pipeBindSessionId.value}`)
}

async function onPipeCreateKB() {
  const pipelines = pipelineStore.pipelines
  if (pipelines.length === 0) return
  const lastPipeline = pipelines[pipelines.length - 1]
  await pipelineStore.createPipelineKB(lastPipeline.id, lastPipeline.name)
  dialogStore.showTransientHint(`📁 已创建专属知识库: ${lastPipeline.name} 知识库`)
}

async function runPipeline() {
  if (pipelineNodeIds.value.length < 2) return
  const steps = pipelineNodeIds.value.map((toolId, idx) => ({
    toolId,
    params: {} as Record<string, string>,
    outputKey: `step${idx}`
  }))
  const pipeline = pipelineStore.createPipeline('手动流水线', steps, 'serial')
  const depInfo = dagDeps.value.map((deps, idx) => `${idx + 1}←[${deps.map(d => d + 1).join(',')}]`).join(' ')
  dialogStore.addSystemNotice(`🔗 流水线启动: ${pipelineNodeIds.value.map(id => getNodeName(id)).join(' → ')} | 依赖: ${depInfo || '串行'}`)
  try {
    const results = await pipelineStore.startPipeline(pipeline.id)
    const lastResult = results ? Object.values(results).pop() || '' : ''
    dialogStore.addSystemNotice('🔗 流水线执行完成')
    if (lastResult && lastResult !== '{"context":""}') {
      dialogStore.addAssistantMessage(lastResult)
    } else {
      dialogStore.addAssistantMessage('(流水线执行完成，无有效输出)')
    }
  } catch (err) {
    const errStr = String(err)
    dialogStore.addSystemNotice(`❌ 流水线执行失败`)
    const debugStore = useDebugStore()
    debugStore.emitEvent('error', 'tool', `流水线执行失败: ${errStr}`, errStr)
  }
  pipelineNodeIds.value = []
  dagDeps.value = []
}

function loadMemory(msg: DialogMessage) {
  inputText.value = msg.content
  dialogStore.addSystemNotice('已载入历史内容到输入框')
}

function thoughtPhaseIcon(phase: ThoughtStep['phase']): string {
  const icons: Record<string, string> = {
    plan: '🧠',
    thought: '💭',
    observation: '👁',
    reflection: '🔄'
  }
  return icons[phase] || '•'
}

function lineageLabel(l: { source: string; tool: string; ruleId?: string; tier?: string }): string {
  const labels: Record<string, string> = {
    llm_pro: '🤖 LLM Pro',
    llm_standard: '🤖 LLM Standard',
    llm_mini: '🤖 LLM Mini',
    llm_nano: '🤖 LLM Nano',
    rule_engine: '📏 规则引擎',
    cache_reuse: '♻️ 缓存复用',
    auto_compiled: '⚡ 编译态',
    skipped: '⏭️ 跳过',
    tool_call: '🔧 工具调用',
    fallback: '🔄 降级'
  }
  const base = labels[l.source] || '❓'
  const extra = l.ruleId ? `(${l.ruleId})` : l.tier ? `[${l.tier}]` : ''
  return `${base} ${l.tool} ${extra}`
}

// P0-C4：会话新建/切换统一走 dialogStore 入口（断数组别名/清暂停点/复位 isProcessing），
// 不再直接操作 sessionStore.switchToSession + 手工赋值 messages
function onNewSession() {
  const s = dialogStore.newSession()
  dialogStore.showTransientHint(`✅ 已创建并切换到: ${s.name}`)
}

function onSwitchSession(sessionId: string) {
  const switched = dialogStore.switchSession(sessionId)
  if (switched) {
    dialogStore.showTransientHint(`🔄 已切换到: ${switched.name}`)
  }
}

function onSessionContextMenu(e: MouseEvent, s: { id: string; name: string }) {
  ctxMenu.visible = true
  ctxMenu.x = e.offsetX
  ctxMenu.y = e.offsetY + 20
  ctxMenu.sessionId = s.id
  ctxMenu.sessionName = s.name
}

function ctxRename() {
  const sid = ctxMenu.sessionId
  ctxMenu.visible = false
  onRenameStart({ id: sid, name: ctxMenu.sessionName })
}

function ctxExport(mode: 'qa' | 'narrative') {
  const sid = ctxMenu.sessionId
  ctxMenu.visible = false
  onExportSession(sid, mode)
}

function ctxClear() {
  const sid = ctxMenu.sessionId
  ctxMenu.visible = false
  sessionStore.clearSession(sid)
  if (sid === sessionStore.activeSessionId) {
    dialogStore.messages = []
  }
  dialogStore.showTransientHint('🧹 已清除会话内容')
}

function ctxConnectKB() {
  ctxMenu.visible = false
  if (knowledgeStore.knowledgeGroups.length === 0) {
    dialogStore.showTransientHint('请先在知识库中创建分组')
    return
  }
  showPanel.value = 'session'
}

function ctxDisconnectKB() {
  const sid = ctxMenu.sessionId
  ctxMenu.visible = false
  sessionStore.disconnectKnowledge(sid)
  dialogStore.showTransientHint('🔓 已断开知识库连接')
}

function onConnectKnowledge(groupId: string) {
  if (!groupId || !sessionStore.activeSessionId) return
  sessionStore.connectKnowledge(sessionStore.activeSessionId, groupId)
  const group = knowledgeStore.knowledgeGroups.find(g => g.id === groupId)
  dialogStore.showTransientHint(`🔗 已连接知识库: ${group?.name || groupId}`)
}

function onDisconnectKnowledge() {
  if (!sessionStore.activeSessionId) return
  sessionStore.disconnectKnowledge(sessionStore.activeSessionId)
  dialogStore.showTransientHint('🔓 已断开知识库连接')
}

function getKnowledgeGroupName(groupId: string): string {
  const group = knowledgeStore.knowledgeGroups.find(g => g.id === groupId)
  return group?.name || groupId.substring(0, 8)
}

function onRenameStart(s: { id: string; name: string }) {
  editingSessionId.value = s.id
  renameValue.value = s.name
  nextTick(() => {
    const input = document.querySelector('.session-item .sess-rename-input') as HTMLInputElement | null
    input?.focus()
    input?.select()
  })
}

function finishRename(sessionId: string) {
  if (editingSessionId.value && renameValue.value.trim()) {
    const origName = sessionStore.sessions.find(s => s.id === sessionId)?.name
    if (renameValue.value.trim() !== origName) {
      sessionStore.renameSession(sessionId, renameValue.value.trim())
    }
  }
  editingSessionId.value = ''
}

function onDocClick(e: MouseEvent) {
  if (ctxMenu.visible) {
    const target = e.target as HTMLElement
    if (!target.closest('.sess-ctx-menu')) {
      ctxMenu.visible = false
    }
  }
  if (editingSessionId.value) {
    const target = e.target as HTMLElement
    if (target.closest('.sess-rename-input')) return
    finishRename(editingSessionId.value)
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  // 2026-10-01：左导航发起的会话级操作（添加附件 / 连接知识库）→ 在这里开对应面板。
  // 只转移「入口」，实际逻辑（FileReader / 选分组）仍只有这一份，不复制。
  // 2026-10-01（用户裁定）：点「附件」不该弹出右侧会话面板——直接弹文件选择即可；
  // 「知识库」自知识库管理提为独立窗口后，也不该再走右栏面板，改为开窗（showPanel='kb' 已失效）。
  uiSessionPanelDisposer = globalBus.on('ui:session-panel', (p: { panel?: 'attach' | 'kb' }) => {
    if (p?.panel === 'kb') {
      openKnowledgeWindow()
      return
    }
    if (p?.panel === 'attach') {
      onAttach('session')
    }
  })
})
onUnmounted(() => { uiSessionPanelDisposer?.(); uiSessionPanelDisposer = null })
onUnmounted(() => { document.removeEventListener('click', onDocClick, true); clearInterval(cacheRefreshTimer) })

function onExportSession(sessionId: string, mode: 'qa' | 'narrative') {
  sessionStore.exportAndDownload(sessionId, mode)
  dialogStore.showTransientHint(`💾 已导出会话 (${mode === 'qa' ? '对话式' : '整合式'})`)
}

function onAddPreference() {
  if (!newPrefKey.value.trim() || !newPrefVal.value.trim()) return
  memoryStore.setPreference(newPrefKey.value.trim(), newPrefVal.value.trim())
  newPrefKey.value = ''
  newPrefVal.value = ''
}

async function onMcpStart(connId: string) {
  const conn = mcpStore.connections.find(c => c.id === connId)
  if (!conn) return
  if (conn.catalogCommand) {
    await mcpStore.startMcpFromCatalog(connId)
  } else {
    await mcpStore.testConnection(connId)
  }
}

async function onInstallMcp(item: McpCatalogItem) {
  await mcpStore.installFromCatalog(item)
  dialogStore.addSystemNotice(`🔌 已安装MCP: ${item.name}`)
}

function onDecayAll() {
  feedbackStore.decayModifiers()
  dialogStore.addSystemNotice('⏳ 已衰减全部权重')
}

async function onClearFeedbackCache() {
  const entries = feedbackStore.entries.slice(-5)
  for (const e of entries) {
    await feedbackStore.clearExecutionCache(e.queryFingerprint)
  }
  dialogStore.addSystemNotice('🗑️ 已清除近期反馈缓存')
}

function onClearRouteCache() {
  clearRouteCache()
  cacheStats.value = getRouteCacheStats()
  dialogStore.addSystemNotice('🗃️ 路由缓存已清除')
}

function exportWorkflowLogs() {
  const lines = workflowLogStore.logs.map(l => {
    const steps = l.nodes.map((n, i) => `  ${i + 1}. ${n.toolId}: ${n.status}`).join('\n')
    return `${l.name} (${l.status})\n${steps}`
  }).join('\n\n')
  const blob = new Blob([lines], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `workflow-logs-${new Date().toISOString().slice(0, 10)}.txt`
  a.click()
  URL.revokeObjectURL(url)
  dialogStore.addSystemNotice('📋 已导出工作流日志')
}

function clearWorkflowLogs() {
  // P1-43：经 store action 清空并同步 vault 持久层（旧实现直写 localStorage 键与 vault 命名空间不一致）
  workflowLogStore.clearLogs()
  dialogStore.addSystemNotice('🗑️ 工作流日志已清空')
}

function onRoleChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value
  configStore.setJobRole(val as JobRole)
}

function toggleDebugMode() {
  if (debugStore.enabled) {
    debugStore.deactivate()
    dialogStore.addSystemNotice('🔍 调试模式已关闭')
  } else {
    debugStore.activate()
    debugStore.updateEnvironment({
      model: apiStore.config.activeModel || '',
      provider: apiStore.config.activeProviderId || '',
      apiReachable: apiStore.isReady,
      nodeCount: nodeStore.nodes.length,
      manifestCount: Object.keys(nodeStore.l2Manifests).length
    })
    dialogStore.addSystemNotice('🔍 调试模式已开启')
    window.electronAPI?.openDebugWindow()
  }
}

const cacheRefreshTimer = setInterval(() => {
  cacheStats.value = getRouteCacheStats()
  const ctx = getFileContext()
  activeFileName.value = ctx.activeFileName
  fileBoostWeight.value = ctx.boostWeight
}, 2000)

async function onRestoreCheckpoint(cpId: string) {
  const cp = await getCheckpoint(cpId)
  if (!cp) { dialogStore.addSystemNotice('❌ 检查点不存在'); return }
  const completedCount = Object.keys(cp.completedResults).length
  dialogStore.addSystemNotice(`🔄 恢复检查点: ${cp.manifestId} (已完成${completedCount}/${cp.totalSteps}步)`)
}

async function onRemoveCheckpoint(cpId: string) {
  await removeCheckpoint(cpId)
  await loadCheckpoints()
  dialogStore.addSystemNotice('🗑️ 检查点已删除')
}

async function loadCheckpoints() {
  checkpointList.value = await getAllCheckpoints()
  // 2026-09-25（机制体检）：接上 resume 候选查询——标出哪些检查点真的可恢复
  // （未完成 + 未过期）。此前该查询零消费者，故用户看不到"可恢复"信息。
  const incomplete = await getIncompleteCheckpoints()
  resumableIds.value = new Set(incomplete.map(c => c.id))
}

</script>

<style scoped>
.dialog-panel {
  position: fixed;
  left: 0;
  top: 28px;
  bottom: 0;
  background: rgba(5, 8, 18, 0.88);
  border-right: 1px solid rgba(80, 160, 255, 0.12);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 400;
  display: flex;
  transition: width 0.15s;
  user-select: none;
}
.dialog-panel.collapsed { transition: width 0.3s; }

/* R16 工作台中栏：静态布局，占满父容器；min-height:0 允许内部 .messages 滚动而非撑破面板 */
.dialog-panel.docked {
  position: static;
  z-index: auto;
  width: 100%;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  top: auto;
  bottom: auto;
  left: auto;
}

.resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 402;
}
.resize-handle:hover,
.resize-handle:active {
  background: rgba(100, 180, 255, 0.2);
}

.dialog-toggle {
  position: absolute;
  right: -24px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 48px;
  background: rgba(5, 8, 18, 0.7);
  border: 1px solid rgba(80, 160, 255, 0.1);
  border-left: none;
  border-radius: 0 4px 4px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #5a7a9a;
  cursor: pointer;
  font-size: var(--font-sm);
  z-index: 401;
  transition: all 0.3s;
}
.dialog-toggle:hover { color: #aaccff; }
.dialog-panel.collapsed .dialog-toggle {
  height: 64px;
  background: rgba(80, 160, 255, 0.15);
  border-color: rgba(80, 160, 255, 0.3);
  box-shadow: 0 0 12px rgba(80, 160, 255, 0.25);
  flex-direction: column;
  gap: 2px;
}
.dialog-panel.collapsed .dialog-toggle .toggle-expand {
  color: #8ab4ff;
  font-size: 12px;
}
.dialog-panel.collapsed .dialog-toggle .toggle-label {
  color: #8ab4ff;
  font-size: var(--font-xs);
  letter-spacing: 1px;
}

.dialog-inner {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.dialog-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.08);
}

.transient-hint {
  padding: 6px 14px;
  background: rgba(100, 180, 255, 0.12);
  border-bottom: 1px solid rgba(100, 180, 255, 0.1);
  color: #7ab8ff;
  font-size: 11px;
  text-align: center;
  animation: hintFade 2.5s ease-out forwards;
}
@keyframes hintFade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}

.mode-tabs {
  display: flex;
  gap: 4px;
}
.mode-btn {
  padding: 4px 10px;
  background: color-mix(in srgb, var(--t-accent, #8ab4ff) 6%, transparent);
  border: 1px solid var(--t-line, rgba(100, 180, 255, 0.1));
  border-radius: 3px;
  color: var(--t-dim, #5a7a9a);
  font-size: var(--font-sm);
  cursor: pointer;
  transition: all 0.2s;
}
.mode-btn.active {
  background: rgba(100, 180, 255, 0.2);
  border-color: rgba(100, 180, 255, 0.5);
  color: #aaccff;
  box-shadow: 0 0 6px rgba(100, 180, 255, 0.3);
}

.engine-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-xs);
  color: #5a7a9a;
}
.engine-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #44ff88;
  animation: enginePulse 2s ease-in-out infinite;
}
@keyframes enginePulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.quick-actions {
  display: flex;
  gap: 4px;
  padding: 6px 14px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.04);
}
/* 2026-10-01：把 ZOL 推到指令行最右（导出按钮留在左侧） */
.qa-spacer { flex: 1; }
.qa-btn {
  width: 28px;
  height: 28px;
  background: color-mix(in srgb, var(--t-accent, #8ab4ff) 6%, transparent);
  border: 1px solid var(--t-line, rgba(100, 180, 255, 0.08));
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.qa-btn:hover { background: color-mix(in srgb, var(--t-accent, #8ab4ff) 16%, transparent); }
.qa-btn.active { background: color-mix(in srgb, var(--t-accent, #8ab4ff) 22%, transparent); border-color: var(--t-accent, #8ab4ff); }
/* 系统消息隐藏条数角标（2026-10-07）；不设 font-size，避免低于全项目 11px 字号下限 */
.qa-badge { margin-left: 1px; opacity: 0.7; }
.qa-more { position: relative; }
.qa-more-dropdown {
  position: absolute;
  top: 32px;
  left: 0;
  background: rgba(12, 20, 40, 0.95);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 100px;
  z-index: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
.qa-more-item {
  padding: 4px 10px;
  font-size: 11px;
  color: #c0d8f0;
  cursor: pointer;
  white-space: nowrap;
}
.qa-more-item:hover { background: rgba(100, 180, 255, 0.12); }
.confirm-bar {
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: 6px;
}
.confirm-bar.plan-confirm-bar { background: rgba(50, 120, 255, 0.08); border: 1px solid rgba(50, 120, 255, 0.25); }
.confirm-bar.intent-confirm-bar { background: rgba(255, 200, 0, 0.06); border: 1px solid rgba(255, 200, 0, 0.2); }
.confirm-bar.slot-fill-bar { background: rgba(255, 60, 60, 0.06); border: 1px solid rgba(255, 60, 60, 0.2); }
.confirm-bar.fact-conflict-bar { background: rgba(255, 30, 30, 0.08); border: 1px solid rgba(255, 30, 30, 0.3); }
.confirm-bar.risk-confirm-bar { background: rgba(255, 60, 0, 0.1); border: 1px solid rgba(255, 60, 0, 0.4); }
.confirm-bar.dag-pause-bar { background: rgba(120, 80, 255, 0.08); border: 1px solid rgba(120, 80, 255, 0.3); }
.confirm-bar.takeover-bar { background: rgba(120, 255, 150, 0.08); border: 1px solid rgba(120, 255, 150, 0.3); }

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(80, 160, 255, 0.25) transparent;
}
.messages::-webkit-scrollbar {
  width: 6px;
}
.messages::-webkit-scrollbar-track {
  background: transparent;
}
.messages::-webkit-scrollbar-thumb {
  background: rgba(80, 160, 255, 0.25);
  border-radius: 3px;
}
.messages::-webkit-scrollbar-thumb:hover {
  background: rgba(80, 160, 255, 0.4);
}

.message {
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.5;
}

.msg-user {
  text-align: right;
}
.msg-user .text-msg {
  display: inline-block;
  background: rgba(50, 120, 200, 0.2);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 8px 2px 8px 8px;
  padding: 8px 12px;
  color: #c0d8ff;
  max-width: 85%;
  text-align: left;
  position: relative;
  word-break: break-word;
  overflow-wrap: break-word;
}
.msg-user .text-msg::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(100, 180, 255, 0.03) 2px, rgba(100, 180, 255, 0.03) 4px);
  pointer-events: none;
  border-radius: inherit;
}

.msg-assistant {
  text-align: left;
}
.msg-assistant .text-msg {
  display: inline-block;
  background: rgba(15, 25, 45, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.08);
  border-radius: 2px 8px 8px 8px;
  padding: 8px 12px;
  color: #a0c0e8;
  max-width: 90%;
  text-align: left;
  word-break: break-word;
  overflow-wrap: break-word;
}

.streaming-cursor::after {
  content: '▊';
  animation: blink 0.8s step-end infinite;
  color: #6ab0ff;
  margin-left: 1px;
}

@keyframes blink {
  50% { opacity: 0; }
}

.msg-system {
  text-align: center;
}
.system-msg {
  display: inline-block;
  padding: 4px 16px;
  /* 系统提示要有实底：对话面板背景是插画，裸文字直接压在插画上可读性差（浅色档尤甚）。
     底色/字色一律走三档令牌，不再硬编码蓝（旧值 #5a7a9a / rgba(100,180,255,0.06)）。 */
  background: var(--t-panel);
  border: 1px solid var(--t-line);
  border-radius: 10px;
  color: var(--t-dim);
  font-size: var(--font-sm);
  animation: fadeIn 0.5s ease-out;
}
.system-notice-text { color: var(--t-dim); }

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-5px); }
  to { opacity: 1; transform: translateY(0); }
}

.workflow-card-msg {
  display: inline-block;
  background: rgba(15, 25, 45, 0.8);
  border: 1px solid rgba(0, 200, 200, 0.2);
  border-radius: 6px;
  padding: 8px 12px;
  max-width: 90%;
}
.wf-card-header {
  font-size: var(--font-sm);
  color: #00dddd;
  margin-bottom: 6px;
}
.wf-card-body {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.wf-node-tag {
  font-size: var(--font-xs);
  padding: 1px 5px;
  background: rgba(100, 180, 255, 0.08);
  border-radius: 2px;
  color: #7a9cc6;
  font-family: 'Consolas', monospace;
}
.wf-status {
  font-size: var(--font-xs);
  padding: 1px 5px;
  border-radius: 2px;
}
.wf-status.running { background: rgba(255, 170, 0, 0.15); color: #ffaa44; }
.wf-status.completed { background: rgba(68, 255, 136, 0.1); color: #44ff88; }
.wf-status.failed { background: rgba(255, 68, 68, 0.1); color: #ff4444; }

.thought-chain {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 90%;
}
.thought-card {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 5px 10px;
  background: rgba(10, 20, 40, 0.6);
  border-radius: 4px;
  border-left: 3px solid rgba(100, 180, 255, 0.3);
  font-size: 11px;
  line-height: 1.4;
}
.tc-plan { border-left-color: #ffa500; }
.tc-thought { border-left-color: #4488ff; }
.tc-observation { border-left-color: #44cc88; }
.tc-reflection { border-left-color: #cc66ff; }
.tc-icon { font-size: 11px; flex-shrink: 0; }
.tc-content { color: #8ab4dd; flex: 1; word-break: break-all; }
.tc-tool { color: #b088e0; font-size: var(--font-xs); flex-shrink: 0; }
.task-plan-card {
  background: rgba(10, 20, 40, 0.7);
  border: 1px solid rgba(255, 165, 0, 0.2);
  border-radius: 6px;
  padding: 8px 12px;
}
.tp-header {
  font-size: 11px;
  color: #ffa500;
  font-weight: bold;
  margin-bottom: 6px;
}
.tp-intent {
  font-size: var(--font-sm);
  color: var(--t-text, #a0c0e8);
  margin-bottom: 2px;
}
.tp-needs {
  font-size: var(--font-sm);
  color: var(--t-dim, #7a9cc6);
  margin-bottom: 6px;
}
.tp-steps {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tp-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-sm);
}
.tp-step-num {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(255, 165, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffa500;
  font-size: var(--font-xs);
  flex-shrink: 0;
}
.tp-step-desc { color: #a0c0e8; flex: 1; }
.tp-step-tool { color: #b088e0; font-size: var(--font-xs); }
.tp-step-deps { color: #ff9944; font-size: var(--font-xs); margin-left: 4px; }
.tp-step-fallback { color: #66bb6a; font-size: var(--font-xs); margin-left: 4px; opacity: 0.7; }

.tool-log-msg {
  display: inline-block;
  max-width: 90%;
}
.tool-log-summary {
  font-size: 11px;
  color: #8ab4ff;
  cursor: pointer;
}
.tool-log-detail {
  margin-top: 4px;
  padding: 6px;
  background: rgba(10, 15, 30, 0.8);
  border-radius: 4px;
}
.tool-step {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  font-size: var(--font-sm);
}
.step-tool { color: #b088e0; min-width: 80px; }
.step-action { color: #5a7a9a; }
.step-result { color: #7a9cc6; flex: 1; }

.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding: 8px 12px;
  background: rgba(15, 25, 45, 0.6);
  border-radius: 8px;
}
.typing-indicator span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #5a7a9a;
  animation: typing 1.2s infinite;
}
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; }
  30% { opacity: 1; }
}

.input-area {
  padding: 10px 14px;
  border-top: 1px solid rgba(100, 180, 255, 0.08);
}
.plan-confirm-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plan-confirm-text {
  flex: 1;
  font-size: 12px;
  color: #ffc800;
}
.confirm-btn {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}
.confirm-btn.yes {
  background: rgba(0, 200, 80, 0.2);
  color: #0f0;
  border: 1px solid rgba(0, 200, 80, 0.3);
}
.confirm-btn.yes:hover {
  background: rgba(0, 200, 80, 0.35);
}
.confirm-btn.no {
  background: rgba(255, 60, 60, 0.15);
  color: #f66;
  border: 1px solid rgba(255, 60, 60, 0.25);
}
.confirm-btn.no:hover {
  background: rgba(255, 60, 60, 0.3);
}
.intent-confirm-bar {
}
.intent-text { font-size: 12px; color: #ffc800; margin-bottom: 4px; }
.intent-detail { font-size: 12px; color: #e0e0e0; margin-bottom: 4px; }
.intent-params { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.intent-param-tag { font-size: 11px; padding: 2px 6px; background: rgba(100,180,255,0.1); border-radius: 3px; color: #88bbff; }
.intent-actions { display: flex; gap: 8px; }
.slot-fill-bar {
}
.slot-title { font-size: 12px; color: #ff8888; margin-bottom: 6px; font-weight: 600; }
.slot-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.slot-label { font-size: 11px; color: #aaa; min-width: 80px; }
.slot-required { color: #ff4444; }
.slot-input {
  flex: 1; padding: 4px 8px; background: rgba(20,30,50,0.8);
  border: 1px solid rgba(100,180,255,0.2); border-radius: 4px;
  color: #c0d8ff; font-size: 12px; outline: none;
}
.slot-input:focus { border-color: rgba(100,180,255,0.5); }
.slot-actions { display: flex; gap: 8px; margin-top: 6px; }
.fact-conflict-bar {
}
.fact-title { font-size: 13px; color: #ff4444; font-weight: 600; margin-bottom: 6px; }
.fact-conflicts { margin-bottom: 8px; }
.fact-conflict-item { margin-bottom: 6px; padding: 4px 6px; background: rgba(0,0,0,0.2); border-radius: 4px; }
.fact-diff { font-size: 12px; color: #ff8888; margin-bottom: 2px; }
.fact-compare { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.fact-source { color: #88ff88; }
.fact-arrow { color: #888; }
.fact-output { color: #ff8888; }
.fact-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.confirm-btn.warn { background: rgba(255,200,0,0.15); color: #ffc800; border: 1px solid rgba(255,200,0,0.3); }
.confirm-btn.warn:hover { background: rgba(255,200,0,0.3); }
.confirm-btn.retry { background: rgba(100,180,255,0.15); color: #88bbff; border: 1px solid rgba(100,180,255,0.3); }
.confirm-btn.retry:hover { background: rgba(100,180,255,0.3); }

.risk-confirm-bar {
}
.risk-title { font-size: 13px; color: #ff6600; font-weight: 600; margin-bottom: 6px; }
.risk-detail { margin-bottom: 8px; }
.risk-row { display: flex; justify-content: space-between; padding: 2px 6px; font-size: 11px; }
.risk-row span:first-child { color: #888; }
.risk-row span:last-child { color: #ccc; }
.risk-input-area { margin-bottom: 8px; }
.risk-hint { font-size: 11px; color: #ff8844; margin-bottom: 4px; }
.risk-input {
  width: 100%; padding: 6px 8px; border: 1px solid rgba(255,60,0,0.3);
  border-radius: 4px; background: rgba(0,0,0,0.3); color: #ccc; font-size: 12px; outline: none;
}
.risk-input:focus { border-color: rgba(255,60,0,0.6); }
.risk-actions { display: flex; gap: 8px; }
.confirm-btn.danger { background: rgba(255,60,0,0.2); color: #ff6600; border: 1px solid rgba(255,60,0,0.4); }
.confirm-btn.danger:hover:not(:disabled) { background: rgba(255,60,0,0.4); }
.confirm-btn.danger:disabled { opacity: 0.3; cursor: default; }
.confirm-btn.cancel { background: rgba(100,100,100,0.2); color: #888; border: 1px solid rgba(255,255,255,0.15); }
.confirm-btn.cancel:hover { background: rgba(100,100,100,0.4); }

.dag-pause-bar {
}
.dag-pause-request { background: rgba(60, 90, 60, 0.08); border: 1px solid rgba(120, 200, 120, 0.25); }
.pause-title { font-size: 13px; color: #88ccff; font-weight: 600; margin-bottom: 6px; }
.pause-actions { display: flex; gap: 8px; }

.takeover-bar {
}
.takeover-title { font-size: 13px; color: #88ffaa; font-weight: 600; margin-bottom: 6px; }
.takeover-input {
  width: 100%; padding: 6px 8px; border: 1px solid rgba(100,255,150,0.3);
  border-radius: 4px; background: rgba(0,0,0,0.3); color: #ccc; font-size: 12px;
  outline: none; resize: vertical; font-family: monospace; margin-bottom: 6px;
}
.takeover-input:focus { border-color: rgba(100,255,150,0.6); }
.takeover-actions { display: flex; gap: 8px; }

.context-hint {
  font-size: var(--font-xs);
  color: #4a6a8a;
  margin-bottom: 4px;
  padding: 2px 6px;
  background: rgba(100, 180, 255, 0.04);
  border-radius: 3px;
}
.drop-zone {
  position: relative;
}
.drop-zone.drop-active {
  outline: 2px dashed rgba(100, 180, 255, 0.5);
  outline-offset: -2px;
  border-radius: 6px;
  background: rgba(50, 120, 200, 0.08);
}
.drag-hint {
  font-size: var(--font-sm);
  color: #8cf;
  margin-top: 4px;
  text-align: center;
  padding: 3px 0;
  background: rgba(50, 120, 200, 0.1);
  border-radius: 3px;
}

textarea {
  width: 100%;
  padding: 8px 10px;
  background: rgba(15, 25, 45, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 6px;
  color: #c0d8ff;
  font-size: 12px;
  resize: none;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  scrollbar-width: thin;
  scrollbar-color: rgba(80, 160, 255, 0.2) transparent;
}
textarea::-webkit-scrollbar {
  width: 5px;
}
textarea::-webkit-scrollbar-track {
  background: transparent;
}
textarea::-webkit-scrollbar-thumb {
  background: var(--t-line, rgba(80, 160, 255, 0.2));
  border-radius: 3px;
}
textarea:focus { border-color: var(--t-accent, rgba(100, 180, 255, 0.35)); }

.send-btn {
  margin-top: 6px;
  width: 100%;
  padding: 6px 0;
  background: color-mix(in srgb, var(--t-accent, #3278c8) 20%, transparent);
  border: 1px solid var(--t-line, rgba(100, 180, 255, 0.2));
  border-radius: 4px;
  color: var(--t-accent, #8ab4ff);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.send-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--t-accent, #3278c8) 35%, transparent); }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.attach-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.attach-tag {
  font-size: var(--font-xs);
  padding: 2px 6px;
  background: rgba(100, 180, 255, 0.1);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 3px;
  color: #8ab4ff;
  display: flex;
  align-items: center;
  gap: 4px;
}
.attach-remove {
  cursor: pointer;
  color: #ff6666;
  font-size: var(--font-sm);
}
.attach-remove:hover { color: #ff4444; }

.lineage-panel {
  margin-top: 6px;
  padding: 4px 8px;
  background: rgba(0, 20, 40, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 4px;
  font-size: var(--font-sm);
}
.file-attachment-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  margin-top: 6px;
  background: color-mix(in srgb, var(--t-accent, #8ab4ff) 8%, transparent);
  border: 1px solid var(--t-line, rgba(100, 180, 255, 0.2));
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 11px;
}
.file-attachment-card:hover {
  background: color-mix(in srgb, var(--t-accent, #8ab4ff) 18%, transparent);
  border-color: var(--t-accent, #8ab4ff);
}
.fa-icon { font-size: 14px; }
.fa-name { color: var(--t-text, #a0c0e8); }
.fa-type { font-size: var(--font-xs); color: var(--t-dim, #5a7a9a); }
.fa-label { color: var(--t-accent, #8ab4ff); text-decoration: underline; cursor: pointer; }
.lineage-header {
  color: rgba(100, 200, 255, 0.7);
  margin-bottom: 3px;
  font-weight: 600;
}
.lineage-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.lineage-tag {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
  white-space: nowrap;
}
.lineage-tag.ln-rule_engine { background: rgba(0, 200, 100, 0.15); color: #4cff8f; }
.lineage-tag.ln-cache_reuse, .lineage-tag.ln-auto_compiled { background: rgba(0, 180, 255, 0.15); color: #4cc8ff; }
.lineage-tag.ln-llm_pro { background: rgba(255, 100, 50, 0.15); color: #ff8844; }
.lineage-tag.ln-llm_standard { background: rgba(255, 180, 50, 0.15); color: #ffbb44; }
.lineage-tag.ln-llm_mini { background: rgba(200, 200, 50, 0.15); color: #cccc44; }
.lineage-tag.ln-llm_nano { background: rgba(150, 150, 150, 0.15); color: #aaa; }
.lineage-tag.ln-skipped { background: rgba(80, 80, 80, 0.15); color: #888; }
.lineage-tag.ln-tool_call { background: rgba(100, 100, 255, 0.15); color: #8888ff; }
.lineage-tag.ln-fallback { background: rgba(255, 150, 150, 0.15); color: #ff8888; }
.result-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.ra-btn {
  width: 24px;
  height: 20px;
  background: color-mix(in srgb, var(--t-accent, #8ab4ff) 8%, transparent);
  border: 1px solid var(--t-line, rgba(100, 180, 255, 0.1));
  border-radius: 3px;
  cursor: pointer;
  font-size: var(--font-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  padding: 0;
}
.ra-btn:hover { background: color-mix(in srgb, var(--t-accent, #8ab4ff) 22%, transparent); border-color: var(--t-accent, #8ab4ff); }
.ra-divider { color: var(--t-line, rgba(100, 180, 255, 0.15)); font-size: var(--font-sm); line-height: 20px; }
.fb-btn.fb-active.fb-up { background: rgba(80, 220, 100, 0.25); border-color: rgba(80, 220, 100, 0.5); }
.fb-btn.fb-active.fb-down { background: rgba(255, 100, 100, 0.25); border-color: rgba(255, 100, 100, 0.5); }
.fb-shake { animation: fb-shake 0.5s ease-in-out; }
@keyframes fb-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-3px); }
  40% { transform: translateX(3px); }
  60% { transform: translateX(-2px); }
  80% { transform: translateX(2px); }
}

.side-panel {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-left: 1px solid rgba(100, 180, 255, 0.1);
  scrollbar-width: thin;
  scrollbar-color: rgba(80, 160, 255, 0.2) transparent;
}

.panel-title {
  font-size: 11px;
  color: #8ab4ff;
  margin-bottom: 6px;
  font-weight: bold;
}
.panel-desc {
  font-size: var(--font-xs);
  color: #5a7a9a;
  margin-bottom: 8px;
}
.pipeline-nodes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.pipe-node {
  font-size: var(--font-xs);
  padding: 3px 8px;
  background: rgba(100, 180, 255, 0.06);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 3px;
  color: #7a9cc6;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.pipe-node:hover { background: rgba(100, 180, 255, 0.15); }
.pipe-node.in-pipe {
  background: rgba(100, 180, 255, 0.2);
  border-color: rgba(100, 180, 255, 0.4);
  color: #aaccff;
}
.pipe-node-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #5a7a9a;
}
.pipe-node.in-pipe .pipe-node-dot { background: #44ff88; }
.pipeline-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  margin-bottom: 8px;
  padding: 6px;
  background: rgba(10, 15, 30, 0.5);
  border-radius: 4px;
}
.pipe-step {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pipe-step-num {
  font-size: var(--font-xs);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(100, 180, 255, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8ab4ff;
}
.pipe-step-name { font-size: var(--font-xs); color: #a0c0e8; }
.pipe-step-arrow { font-size: var(--font-sm); color: #5a7a9a; margin: 0 2px; }
.pipe-run-btn {
  width: 100%;
  padding: 5px;
  background: rgba(68, 255, 136, 0.1);
  border: 1px solid rgba(68, 255, 136, 0.2);
  border-radius: 4px;
  color: #44ff88;
  font-size: var(--font-sm);
  cursor: pointer;
  margin-bottom: 4px;
}
.pipe-run-btn:hover { background: rgba(68, 255, 136, 0.2); }
.pipe-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pipe-clear-btn {
  width: 100%;
  padding: 4px;
  background: transparent;
  border: 1px solid rgba(255, 100, 100, 0.15);
  border-radius: 4px;
  color: #ff6666;
  font-size: var(--font-xs);
  cursor: pointer;
}
.pipe-source-tabs { display: flex; gap: 2px; margin-bottom: 6px; }
.pipe-src-tab { padding: 2px 8px; background: rgba(100,180,255,0.06); border: 1px solid rgba(100,180,255,0.1); border-radius: 3px; color: #5a7a9a; font-size: var(--font-xs); cursor: pointer; }
.pipe-src-tab.active { background: rgba(100,180,255,0.15); border-color: rgba(100,180,255,0.3); color: #8ab4ff; }
.pipe-node-dot.skill { background: #ff9944; }
.pipe-node-dot.mcp { background: #44ddff; }
.pipeline-dag { margin-bottom: 8px; }
.pipe-dag-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.pipe-dag-header span { font-size: var(--font-sm); color: #8ab4ff; }
.pipe-auto-btn { padding: 1px 6px; background: rgba(255,153,68,0.15); border: 1px solid rgba(255,153,68,0.3); border-radius: 3px; color: #ff9944; font-size: var(--font-xs); cursor: pointer; }
.pipe-auto-btn:hover { background: rgba(255,153,68,0.3); }
.pipe-dag-canvas { display: flex; flex-direction: column; gap: 3px; }
.dag-node { padding: 3px 6px; background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 4px; cursor: grab; }
.dag-node:active { cursor: grabbing; border-color: rgba(100,180,255,0.4); }
.dag-node-header { display: flex; align-items: center; gap: 4px; }
.dag-num { font-size: var(--font-xs); width: 14px; height: 14px; border-radius: 50%; background: rgba(100,180,255,0.2); display: flex; align-items: center; justify-content: center; color: #8ab4ff; flex-shrink: 0; }
.dag-name { font-size: var(--font-sm); color: #c0d8f0; flex: 1; }
.dag-remove { background: none; border: none; color: #ff4444; cursor: pointer; font-size: var(--font-xs); padding: 0; opacity: 0.5; }
.dag-remove:hover { opacity: 1; }
.dag-deps { display: flex; align-items: center; gap: 3px; margin-top: 2px; padding-left: 18px; }
.dag-dep-label { font-size: var(--font-xs); color: #5a7a9a; }
.dag-dep-tag { font-size: var(--font-xs); padding: 0 4px; background: rgba(68,255,136,0.15); border-radius: 2px; color: #44ff88; cursor: pointer; }
.dag-dep-tag:hover { background: rgba(255,100,100,0.2); color: #ff6666; }
.dag-dep-add { font-size: var(--font-sm); color: #5a7a9a; cursor: pointer; margin-left: 2px; }
.dag-dep-add:hover { color: #8ab4ff; }
.kb-stats {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
}
.kb-stat {
  font-size: var(--font-sm);
  color: #7a9cc6;
}
.kb-stat strong { color: #8ab4ff; }
.kb-files {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kb-file {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 6px;
  background: rgba(100, 180, 255, 0.04);
  border-radius: 3px;
}
.kb-file-name { font-size: var(--font-sm); color: #a0c0e8; }
.kb-file-chunks { font-size: var(--font-xs); color: #5a7a9a; }
.kb-empty { font-size: var(--font-sm); color: #5a7a9a; text-align: center; padding: 8px; }
.kb-search-row { display: flex; gap: 4px; margin-bottom: 6px; }
.kb-search-input { flex: 1; background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #c0d8ff; font-size: var(--font-sm); padding: 3px 6px; outline: none; }
.kb-search-input:focus { border-color: rgba(100,180,255,0.4); }
.kb-search-btn { background: rgba(100,180,255,0.15); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #8ab4ff; cursor: pointer; font-size: var(--font-sm); padding: 0 6px; }
.kb-search-btn:hover { background: rgba(100,180,255,0.25); }
.kb-search-btn:disabled { opacity: 0.4; }
.kb-search-results { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
.kb-result-item { display: flex; gap: 4px; padding: 2px 4px; background: rgba(100,180,255,0.04); border-radius: 2px; font-size: var(--font-xs); }
.kb-result-score { color: #44ff88; min-width: 30px; font-weight: bold; }
.kb-result-text { color: #7a9cc6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-group-toolbar { display: flex; gap: 4px; margin-bottom: 6px; }
.kb-grp-input { flex: 1; padding: 2px 6px; background: rgba(100,180,255,0.06); border: 1px solid rgba(100,180,255,0.12); border-radius: 3px; color: #c0d8ff; font-size: var(--font-xs); outline: none; }
.kb-grp-input:focus { border-color: rgba(100,180,255,0.3); }
.kb-grp-input::placeholder { color: #3a5a7a; }
.kb-grp-btn { padding: 2px 8px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #8ab4ff; font-size: var(--font-xs); cursor: pointer; }
.kb-grp-btn:hover { background: rgba(100,180,255,0.2); }
.kb-grp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.kb-search-empty { padding: 8px; text-align: center; color: #5a7a9a; font-size: var(--font-sm); }
.kb-tree { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; margin-bottom: 6px; }
.kb-group-node { border: 1px solid rgba(100,180,255,0.06); border-radius: 4px; }
.kb-group-header { display: flex; align-items: center; gap: 4px; padding: 3px 6px; cursor: pointer; background: rgba(100,180,255,0.04); border-radius: 3px; }
.kb-group-header:hover { background: rgba(100,180,255,0.08); }
.kb-group-arrow { font-size: var(--font-xs); color: #5a7a9a; width: 8px; }
.kb-group-icon { font-size: var(--font-sm); }
.kb-group-name { font-size: var(--font-sm); color: #c0d8f0; flex: 1; }
.kb-group-meta { font-size: var(--font-xs); color: #5a7a9a; }
.kb-grp-del { background: none; border: none; color: #ff4444; font-size: var(--font-xs); cursor: pointer; opacity: 0.5; }
.kb-grp-del:hover { opacity: 1; }
.kb-group-children { padding-left: 14px; }
.kb-shared-section { padding: 2px 0; border-bottom: 1px solid rgba(100,180,255,0.04); }
.kb-section-label { font-size: var(--font-xs); color: #7a9cc6; padding: 2px 0; display: block; }
.kb-tree-entry { display: flex; justify-content: space-between; align-items: center; padding: 1px 4px; }
.kb-te-name { font-size: var(--font-xs); color: #a0c0e8; }
.kb-te-del { background: none; border: none; color: #ff6666; font-size: var(--font-xs); cursor: pointer; }
.kb-tree-empty { font-size: var(--font-xs); color: #5a7a9a; padding: 1px 4px; }
.kb-proj-node { display: flex; align-items: center; gap: 4px; padding: 2px 4px; }
.kb-proj-icon { font-size: var(--font-xs); }
.kb-proj-name { font-size: var(--font-xs); color: #a0c0e8; flex: 1; }
.kb-proj-meta { font-size: var(--font-xs); color: #5a7a9a; }
.kb-grp-select { background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 2px; color: #8ab4ff; font-size: var(--font-xs); padding: 0 2px; max-width: 70px; }
.kb-grp-select option { background: #0a0f1e; }
.kb-ungrouped { border-top: 1px solid rgba(100,180,255,0.06); padding-top: 4px; margin-top: 2px; }
.memory-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 140px;
  overflow-y: auto;
}
.memory-item {
  display: flex;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.2s;
}
.memory-item:hover { background: rgba(100, 180, 255, 0.08); }
.mem-role { font-size: var(--font-sm); }
.mem-text { font-size: var(--font-xs); color: #7a9cc6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-empty { font-size: var(--font-sm); color: #5a7a9a; text-align: center; padding: 8px; }

.macro-create-panel { padding: 6px; }
.macro-form { display: flex; flex-direction: column; gap: 4px; }
.macro-label { font-size: var(--font-sm); color: #7a9cc6; margin-top: 4px; }
.macro-input, .macro-textarea {
  background: rgba(10, 15, 30, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 4px;
  color: #c0d8f0;
  font-size: 11px;
  padding: 4px 6px;
  resize: vertical;
}
.macro-input:focus, .macro-textarea:focus { outline: none; border-color: rgba(100, 180, 255, 0.4); }
.macro-save-btn {
  background: rgba(255, 153, 68, 0.2);
  border: 1px solid rgba(255, 153, 68, 0.4);
  border-radius: 4px;
  color: #ff9944;
  font-size: 11px;
  padding: 4px 8px;
  cursor: pointer;
  margin-top: 4px;
}
.macro-save-btn:hover { background: rgba(255, 153, 68, 0.3); }
.macro-save-msg { font-size: var(--font-sm); color: #88ff88; margin-top: 2px; }
.macro-save-msg.error { color: #ff8888; }
.macro-existing { margin-top: 8px; border-top: 1px solid rgba(100, 180, 255, 0.1); padding-top: 6px; }
.panel-subtitle { font-size: var(--font-sm); color: #5a7a9a; margin-bottom: 4px; }
.macro-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.macro-item-name { font-size: 11px; color: #ff9944; flex: 1; }
.macro-del-btn { background: none; border: none; color: #ff4444; cursor: pointer; font-size: var(--font-sm); padding: 0 2px; }

.timeline-panel { padding: 6px; }
.timeline-list { max-height: 180px; overflow-y: auto; }
.timeline-entry { padding: 4px 6px; border-radius: 4px; cursor: pointer; margin-bottom: 2px; border: 1px solid transparent; }
.timeline-entry:hover { background: rgba(100, 180, 255, 0.05); }
.timeline-entry.active { border-color: rgba(100, 180, 255, 0.3); background: rgba(100, 180, 255, 0.08); }
.timeline-header { display: flex; align-items: center; gap: 4px; }
.timeline-status { font-size: 11px; }
.timeline-name { font-size: 11px; color: #c0d8f0; }
.timeline-meta { font-size: var(--font-xs); color: #5a7a9a; margin-left: 18px; }
.timeline-detail { margin-top: 6px; border-top: 1px solid rgba(100, 180, 255, 0.1); padding-top: 6px; }
.timeline-steps { display: flex; flex-wrap: wrap; gap: 2px; margin: 4px 0; }
.timeline-step { padding: 2px 4px; border-radius: 3px; cursor: pointer; font-size: var(--font-sm); border: 1px solid rgba(100, 180, 255, 0.1); }
.timeline-step.active { border-color: rgba(100, 180, 255, 0.4); background: rgba(100, 180, 255, 0.1); }
.step-status { font-size: var(--font-sm); }
.step-tool { color: #88aacc; font-size: var(--font-sm); }
.timeline-io { margin-top: 4px; }
.timeline-toolbar { display: flex; gap: 4px; margin-bottom: 6px; }
.tl-tool-btn { padding: 2px 8px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #8ab4ff; font-size: var(--font-xs); cursor: pointer; }
.tl-tool-btn:hover { background: rgba(100,180,255,0.2); }

.file-context-bar { display: flex; align-items: center; gap: 4px; padding: 2px 14px; background: rgba(100,180,255,0.04); border-bottom: 1px solid rgba(100,180,255,0.06); font-size: var(--font-xs); }
.fc-icon { font-size: var(--font-sm); }
.fc-name { color: #8ab4ff; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-boost { color: #44ff88; background: rgba(68,255,136,0.1); padding: 0 4px; border-radius: 2px; font-size: var(--font-xs); }

.session-panel { padding: 6px; position: relative; }
.session-toolbar { display: flex; gap: 4px; margin-bottom: 6px; }
.sess-btn { padding: 3px 10px; border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; font-size: var(--font-sm); cursor: pointer; }
.sess-btn.sess-new { background: rgba(68,255,136,0.1); color: #44ff88; border-color: rgba(68,255,136,0.2); }
.sess-btn.sess-new:hover { background: rgba(68,255,136,0.2); }
.session-list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; }
.session-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; border-radius: 3px; cursor: pointer; border: 1px solid transparent; transition: all 0.15s; }
.session-item:hover { background: rgba(100,180,255,0.05); }
.session-item.active { border-color: rgba(100,180,255,0.3); background: rgba(100,180,255,0.08); }
.session-item.archived { opacity: 0.5; }
.sess-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.sess-name { font-size: 11px; color: #c0d8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-meta { font-size: var(--font-xs); color: #5a7a9a; }
.sess-rename-input { background: rgba(10,15,30,0.8); border: 1px solid rgba(100,180,255,0.3); border-radius: 3px; color: #c0d8ff; font-size: 11px; padding: 1px 4px; width: 100%; outline: none; }
.sess-actions { display: flex; gap: 2px; flex-shrink: 0; }
.sess-act { background: none; border: none; cursor: pointer; font-size: var(--font-xs); padding: 0 2px; opacity: 0.6; transition: opacity 0.2s; }
.sess-act:hover { opacity: 1; }
.sess-del:hover { color: #ff4444; }
.sess-ctx-menu { position: absolute; background: rgba(12,20,40,0.95); border: 1px solid rgba(100,180,255,0.2); border-radius: 5px; padding: 4px 0; min-width: 140px; z-index: 100; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
.ctx-item { padding: 5px 12px; font-size: 11px; color: #c0d8f0; cursor: pointer; white-space: nowrap; }
.ctx-item:hover { background: rgba(100,180,255,0.12); }
.ctx-warn { color: #ffaa66; }
.ctx-warn:hover { background: rgba(255,100,50,0.1); }
.ctx-sep { height: 1px; background: rgba(100,180,255,0.1); margin: 3px 8px; }

.memory-mgmt-panel { padding: 6px; }
.mem-section { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(100,180,255,0.06); }
.mem-section:last-child { border-bottom: none; }
.mem-section-title { font-size: var(--font-sm); color: #8ab4ff; margin-bottom: 4px; font-weight: 600; }
.mem-proj-list { display: flex; flex-direction: column; gap: 2px; max-height: 80px; overflow-y: auto; }
.mem-proj-item { display: flex; justify-content: space-between; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: var(--font-sm); }
.mem-proj-item:hover { background: rgba(100,180,255,0.06); }
.mem-proj-item.active { background: rgba(100,180,255,0.12); }
.mp-name { color: #c0d8f0; }
.mp-meta { color: #5a7a9a; font-size: var(--font-xs); }
.mem-add-row { display: flex; gap: 4px; margin-top: 4px; }
.mem-add-input { flex: 1; min-width: 0; background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #c0d8ff; font-size: var(--font-sm); padding: 2px 4px; outline: none; }
.mem-add-input:focus { border-color: rgba(100,180,255,0.4); }
.mem-add-btn { background: rgba(100,180,255,0.15); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #8ab4ff; cursor: pointer; font-size: 11px; padding: 0 6px; }
.mem-add-btn:hover { background: rgba(100,180,255,0.25); }
.mem-tpl-list { display: flex; flex-direction: column; gap: 2px; }
.mem-tpl-item { display: flex; justify-content: space-between; align-items: center; padding: 2px 6px; }
.mt-name { font-size: var(--font-sm); color: #a0c0e8; }
.mt-del { background: none; border: none; color: #ff6666; cursor: pointer; font-size: var(--font-xs); }
.mem-pref-list { display: flex; flex-direction: column; gap: 2px; }
.mem-pref-item { display: flex; gap: 6px; padding: 1px 6px; font-size: var(--font-sm); }
.mp-key { color: #8ab4ff; min-width: 60px; }
.mp-val { color: #7a9cc6; }
.mem-terms { display: flex; flex-wrap: wrap; gap: 2px; }
.mem-term-tag { font-size: var(--font-xs); padding: 1px 4px; background: rgba(100,180,255,0.08); border-radius: 2px; color: #7a9cc6; }

.mcp-panel { padding: 6px; }
.mcp-conn-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
.mcp-conn-item { padding: 4px 6px; background: rgba(10,15,30,0.5); border-radius: 4px; border: 1px solid rgba(100,180,255,0.08); }
.mcp-conn-header { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
.mcp-conn-dot { width: 6px; height: 6px; border-radius: 50%; }
.mcp-conn-dot.on { background: #44ff88; box-shadow: 0 0 4px rgba(68,255,136,0.5); }
.mcp-conn-dot.off { background: #555; }
.mcp-conn-name { font-size: 11px; color: #c0d8f0; }
.mcp-conn-meta { font-size: var(--font-xs); color: #5a7a9a; margin-bottom: 4px; }
.mcp-conn-actions { display: flex; gap: 4px; margin-bottom: 4px; }
.mcp-act { padding: 1px 6px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #8ab4ff; font-size: var(--font-xs); cursor: pointer; }
.mcp-act:hover { background: rgba(100,180,255,0.2); }
.mcp-act.mcp-del { color: #ff6666; border-color: rgba(255,100,100,0.15); }
.mcp-tools { display: flex; flex-direction: column; gap: 1px; }
.mcp-tool-item { display: flex; justify-content: space-between; align-items: center; padding: 1px 4px; font-size: var(--font-xs); }
.mcp-tool-item.disabled { opacity: 0.5; }
.mtp-name { color: #7a9cc6; }
.mtp-toggle { background: none; border: none; cursor: pointer; font-size: var(--font-xs); }
.mcp-add-section { margin-top: 6px; border-top: 1px solid rgba(100,180,255,0.08); padding-top: 6px; }
.mcp-catalog-item { display: flex; justify-content: space-between; align-items: center; padding: 2px 6px; }
.mc-name { font-size: var(--font-sm); color: #a0c0e8; }
.mc-install { background: rgba(68,255,136,0.1); border: 1px solid rgba(68,255,136,0.2); border-radius: 3px; color: #44ff88; font-size: var(--font-xs); cursor: pointer; padding: 1px 6px; }
.mc-install:hover { background: rgba(68,255,136,0.2); }
.mc-installed { font-size: var(--font-xs); color: #5a7a9a; }

.feedback-panel { padding: 6px; }
.fb-stats { display: flex; gap: 10px; margin-bottom: 6px; font-size: var(--font-sm); color: #7a9cc6; }
.fb-stat strong { color: #8ab4ff; }
.fb-weight-list { display: flex; flex-direction: column; gap: 2px; max-height: 140px; overflow-y: auto; }
.fb-weight-item { display: flex; align-items: center; gap: 6px; padding: 2px 6px; }
.fw-id { font-size: var(--font-xs); color: #7a9cc6; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fw-val { font-size: var(--font-sm); font-weight: bold; min-width: 55px; text-align: right; }
.fw-val.positive { color: #44ff88; }
.fw-val.negative { color: #ff6666; }
.fw-reset { background: none; border: 1px solid rgba(100,180,255,0.1); border-radius: 2px; color: #5a7a9a; font-size: var(--font-xs); cursor: pointer; padding: 0 4px; }
.fw-reset:hover { color: #8ab4ff; }
.fb-actions { display: flex; gap: 4px; margin-top: 6px; }
.fb-act-btn { padding: 3px 8px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #8ab4ff; font-size: var(--font-xs); cursor: pointer; }
.fb-act-btn:hover { background: rgba(100,180,255,0.2); }

.cache-panel { padding: 6px; }
.cache-stats { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.cs-row { display: flex; justify-content: space-between; padding: 2px 6px; font-size: var(--font-sm); color: #7a9cc6; }
.cs-hit { color: #44ff88; }
.cs-miss { color: #ff6666; }
.cache-clear-btn { width: 100%; padding: 4px; background: rgba(255,100,100,0.1); border: 1px solid rgba(255,100,100,0.2); border-radius: 3px; color: #ff6666; font-size: var(--font-sm); cursor: pointer; }
.cache-clear-btn:hover { background: rgba(255,100,100,0.2); }

.settings-panel { padding: 6px; }
.set-section { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(100,180,255,0.06); }
.set-section:last-child { border-bottom: none; }
.set-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
.set-label { font-size: 11px; color: #a0c0e8; }
.set-theme-btn { padding: 2px 8px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #8ab4ff; font-size: var(--font-sm); cursor: pointer; }
.set-theme-btn:hover { background: rgba(100,180,255,0.2); }
.budget-mode-btns { display: flex; gap: 4px; }
.budget-btn { padding: 2px 8px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #8ab4ff; font-size: var(--font-sm); cursor: pointer; }
.budget-btn:hover { background: rgba(100,180,255,0.2); }
.budget-btn.active { background: rgba(100,180,255,0.3); border-color: rgba(100,180,255,0.5); color: #fff; }
.set-val { font-size: var(--font-sm); color: #a0c0e8; font-family: monospace; }
.set-select { background: rgba(10,15,30,0.8); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #c0d8ff; font-size: var(--font-sm); padding: 2px 4px; outline: none; }
.set-select option { background: #0a0f1e; color: #c0d8ff; }
.set-skill-item { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; }
.ss-name { font-size: var(--font-sm); color: #a0c0e8; }
.ss-del { background: none; border: none; color: #ff6666; cursor: pointer; font-size: var(--font-xs); }
.cp-list { display: flex; flex-direction: column; gap: 4px; max-height: 120px; overflow-y: auto; }
.cp-item { padding: 4px 6px; background: rgba(10,15,30,0.5); border-radius: 3px; border: 1px solid rgba(100,180,255,0.08); }
.cp-header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.cp-id { font-size: var(--font-sm); color: #c0d8f0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-badge { font-size: var(--font-xs); color: #ffcc66; background: rgba(255,204,102,0.12); border: 1px solid rgba(255,204,102,0.3); padding: 0 4px; border-radius: 2px; white-space: nowrap; }
.cp-progress { font-size: var(--font-xs); color: #44ff88; background: rgba(68,255,136,0.1); padding: 0 4px; border-radius: 2px; }
.cp-meta { font-size: var(--font-xs); color: #5a7a9a; margin: 2px 0; }
.cp-actions { display: flex; gap: 4px; }
.cp-btn { padding: 1px 6px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); border-radius: 2px; color: #8ab4ff; font-size: var(--font-xs); cursor: pointer; }
.cp-btn:hover { background: rgba(100,180,255,0.2); }
.cp-btn.cp-del { color: #ff6666; border-color: rgba(255,100,100,0.15); }
.attachment-panel { padding: 6px; }
.att-upload-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.att-upload-btn { padding: 3px 10px; background: rgba(68,255,136,0.1); border: 1px solid rgba(68,255,136,0.2); border-radius: 3px; color: #44ff88; font-size: var(--font-sm); cursor: pointer; }
.att-upload-btn:hover { background: rgba(68,255,136,0.2); }
.att-count { font-size: var(--font-xs); color: #5a7a9a; }
.att-tabs { display: flex; gap: 2px; margin-bottom: 6px; }
.att-tab { padding: 2px 8px; background: rgba(100,180,255,0.06); border: 1px solid rgba(100,180,255,0.1); border-radius: 3px; color: #5a7a9a; font-size: var(--font-sm); cursor: pointer; }
.att-tab.active { background: rgba(100,180,255,0.15); border-color: rgba(100,180,255,0.3); color: #8ab4ff; }
.att-file-list { display: flex; flex-direction: column; gap: 3px; max-height: 160px; overflow-y: auto; }
.att-file-item { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; background: rgba(100,180,255,0.04); border-radius: 3px; }
.att-file-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.att-file-name { font-size: var(--font-sm); color: #c0d8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-file-meta { font-size: var(--font-xs); color: #5a7a9a; }
.att-del-btn { background: none; border: none; cursor: pointer; font-size: var(--font-sm); opacity: 0.6; }
.att-del-btn:hover { opacity: 1; }
.att-ref-list { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow-y: auto; }
.att-ref-item { display: flex; justify-content: space-between; padding: 2px 6px; font-size: var(--font-xs); }
.att-ref-text { color: #7a9cc6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.att-ref-time { color: #5a7a9a; flex-shrink: 0; margin-left: 4px; }

.sess-kb-badge { font-size: var(--font-xs); background: rgba(100,200,100,0.15); color: #7dcea0; padding: 0 4px; border-radius: 2px; margin-left: 4px; }
.sess-att-badge { font-size: var(--font-xs); background: rgba(100,180,255,0.15); color: #7ab8e0; padding: 0 3px; border-radius: 2px; margin-left: 4px; }
.sess-kb-status { display: flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: var(--font-xs); color: #8ab4d8; border-top: 1px solid rgba(100,180,255,0.08); }
.sess-kb-disconnect { background: none; border: 1px solid rgba(255,100,100,0.3); color: #e88; font-size: var(--font-xs); padding: 1px 6px; border-radius: 2px; cursor: pointer; }
.sess-kb-disconnect:hover { background: rgba(255,100,100,0.1); }
.sess-kb-select { font-size: var(--font-xs); background: rgba(20,30,50,0.6); color: #8ab4d8; border: 1px solid rgba(100,180,255,0.15); border-radius: 2px; padding: 1px 4px; }
.sess-btn.sess-upload { font-size: var(--font-xs); padding: 2px 8px; background: rgba(100,180,255,0.12); border: 1px solid rgba(100,180,255,0.2); color: #8ab4d8; border-radius: 3px; cursor: pointer; }
.sess-btn.sess-upload:hover { background: rgba(100,180,255,0.2); }

.pipe-binding-row { display: flex; gap: 4px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.pipe-bind-select { font-size: var(--font-xs); background: rgba(20,30,50,0.6); color: #8ab4d8; border: 1px solid rgba(100,180,255,0.15); border-radius: 2px; padding: 2px 4px; max-width: 120px; }
.pipe-bound-badge { font-size: var(--font-xs); color: #44ff88; background: rgba(68,255,136,0.1); border: 1px solid rgba(68,255,136,0.2); border-radius: 3px; padding: 1px 6px; white-space: nowrap; }
.pipe-btn { font-size: var(--font-xs); padding: 2px 6px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); color: #8ab4d8; border-radius: 2px; cursor: pointer; white-space: nowrap; }
.pipe-btn:hover { background: rgba(100,180,255,0.2); }
.pipe-upload-target { display: flex; gap: 4px; align-items: center; font-size: var(--font-xs); color: #8ab4d8; margin-bottom: 4px; }
.pipe-ut-btn { font-size: var(--font-xs); padding: 1px 6px; background: rgba(20,30,50,0.6); border: 1px solid rgba(100,180,255,0.15); color: #7a9cc6; border-radius: 2px; cursor: pointer; }
.pipe-ut-btn.active { background: rgba(100,180,255,0.2); border-color: rgba(100,180,255,0.4); color: #b0d4f1; }

.kb-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.kb-upload-btn { font-size: var(--font-xs); padding: 3px 10px; background: rgba(100,180,255,0.12); border: 1px solid rgba(100,180,255,0.2); color: #8ab4d8; border-radius: 3px; cursor: pointer; }
.kb-upload-btn:hover { background: rgba(100,180,255,0.25); }
.kb-count { font-size: var(--font-xs); color: #5a7a9a; }
.kb-tabs { display: flex; gap: 2px; margin-bottom: 6px; }
.kb-tab { font-size: var(--font-xs); padding: 2px 10px; background: rgba(20,30,50,0.6); border: 1px solid rgba(100,180,255,0.1); color: #5a7a9a; border-radius: 2px 2px 0 0; cursor: pointer; }
.kb-tab.active { background: rgba(100,180,255,0.12); color: #b0d4f1; border-color: rgba(100,180,255,0.3); }
.kb-ref-list { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow-y: auto; }
.kb-ref-item { display: flex; justify-content: space-between; padding: 2px 6px; font-size: var(--font-xs); }
.kb-ref-text { color: #7a9cc6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.kb-ref-time { color: #5a7a9a; flex-shrink: 0; margin-left: 4px; }

.set-collapsible { margin-bottom: 2px; }
.set-collapsible-header { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; font-size: var(--font-sm); font-weight: 600; color: #8ab4d8; cursor: pointer; background: rgba(100,180,255,0.04); border-radius: 3px; margin-bottom: 1px; }
.set-collapsible-header:hover { background: rgba(100,180,255,0.08); }
.set-collapse-arrow { font-size: var(--font-xs); color: #5a7a9a; }
.set-collapsible-body { padding: 4px 0 4px 8px; border-left: 2px solid rgba(100,180,255,0.1); margin-left: 8px; margin-bottom: 4px; }

/* 旧 green 主题块（.dialog-panel / .mode-btn / .msg-content / select / 滚动条）已于 2026-10-07 清除：
 * 主题唯一定义处是 src/styles/tokens.css。这些旧规则按"深绿底"写，会被 tokens 的新绿档覆盖
 * （注入顺序 + !important），是纯冲突源；其中 tokens 未覆盖的 select option 已并入 tokens.css。 */
</style>
