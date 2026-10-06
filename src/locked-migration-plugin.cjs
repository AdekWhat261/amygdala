'use strict';
const { prepareLockedMigration, validateLockedPlan, executeSlotLocks,
  prepareSlotActivation, executeSlotActivation } = require('./locked-migration.cjs');
const { createGoogleLockAdapter, probeGoogleLockAtomicity } = require('./google-locked-migration.cjs');
const { readLockedMigrationSnapshot } = require('./locked-migration-snapshot.cjs');
const { readOnlyMigrationSnapshot, readOnlySchema2MigrationPreview } = require('./legacy-migration-remote-preview.cjs');
const { buildVerifiedBackup, encodeBackup, decodeBackup } = require('./verified-backup.cjs');
const { verifyBackupWithReader } = require('./backup-reader-verification.cjs');
const { TeamShardedStore } = require('./team-sharded-store.cjs');
const { LOCK_PROTOCOL, fenceDigest, canonical } = require('./slot-fence.cjs');
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const same = (a, b) => canonical(a) === canonical(b);
const fail = message => { throw new Error(message); };
const bucket = 'lockedMigrationPreparations';
const backupPath = (root, digest) => `.easy-sync/recovery/migration/${root}/${digest}.json`;
const legacyBlocker = 'Старый план V1 заблокирован. Его записи не возобновляются; сохранённые данные требуют отдельной проверки.';

/** Session consent is never serialized. All persistence precedes consequential writes. */
function createLockedMigrationMethods({ createStore, Setting, Notice, locks }) {
  function busy(p) {
    return p.stopped || p.running || p.checkingGoogleAccess || p.migrationPreviewing || p.migrationPreparing || p.migrationApplying;
  }
  function queued(p, root) {
    const legacy = p.pluginData?.v4Operations || {};
    return Object.keys(p.pluginData?.v4ScopedOperations?.[root] || {}).length > 0
      || Object.keys(legacy[root] || {}).length > 0
      || Object.entries(legacy).some(([key, record]) => key !== root
        && (!record?.rootId || record.rootId === root));
  }
  function clearConsent(p) { p.migrationWriteApprovedFingerprint = null; p.migrationAllParticipantsPaused = false; }
  function savedFor(p) { return p.pluginData?.[bucket]?.[p.connection?.id]; }
  function fingerprint(saved) { return saved?.stage === 'final-ready' ? saved.activation?.sourceFingerprint : saved?.plan?.sourceFingerprint; }
  function eligibility(p, saved) {
    p.migrationPreparationEligibility = { rootId: saved.plan.rootId, scopePath: saved.plan.scopePath, generation: p.autoSyncGeneration || 0 };
    p.lastMigrationPreview = p.migrationPreviewForPlan(saved.plan, { ...saved.preview,
      migrationState: saved.completed ? 'complete' : saved.stage === 'final-ready' ? 'final-ready' : saved.attempted ? 'partial' : 'source' });
    p.lastMigrationPreview.snapshotFingerprint = fingerprint(saved);
  }
  function context(p, saved, approvedFingerprint) {
    const connection = p.connection, connectionIdentity = JSON.stringify(connection), root = connection.id;
    const scope = p.teamScopePath(), generation = p.autoSyncGeneration || 0;
    const identity = saved ? JSON.stringify(saved.plan) : null;
    const planDigest = saved?.planDigest;
    const assert = () => {
      if (p.stopped || p.running || p.migrationLiveWriteBlocker() || p.connection !== connection || JSON.stringify(p.connection) !== connectionIdentity
        || p.connectionAuthMode() !== 'team-v4' || p.teamScopePath() !== scope || (p.autoSyncGeneration || 0) !== generation
        || p.prefs?.auto !== false || queued(p, root)
        || (saved && (JSON.stringify(savedFor(p)?.plan) !== identity || savedFor(p)?.planDigest !== planDigest))
        || (approvedFingerprint && (p.migrationWriteApprovedFingerprint !== approvedFingerprint || p.migrationAllParticipantsPaused !== true)))
        fail('Проект, папка, очередь или согласие изменились. Записи остановлены; сохранённый план можно проверить и продолжить.');
    };
    const guarded = async operation => { assert(); const value = await operation(); assert(); return value; };
    return { assert, guarded, root, scope, generation, lock: `team-${p.device}-${root}` };
  }
  // Use a copy so a failed save cannot leave an apparently persisted probe or activation in memory.
  async function persist(p, ctx, change) {
    const operation = p.diagnosticWrite.catch(() => {}).then(async () => {
      ctx.assert();
      if (typeof p.saveData !== 'function') fail('Локальное сохранение плана недоступно.');
      const next = structuredClone(p.pluginData);
      change(next); ctx.assert();
      await p.saveData(next);
      p.pluginData = next; ctx.assert();
    });
    p.diagnosticWrite = operation;
    return ctx.guarded(() => operation);
  }
  function storeFor(p, ctx) {
    const store = createStore(p, ctx.root);
    // Protect each network/auth boundary, including reads inside adapter operations.
    for (const name of ['call', 'batch', 'request', 'sleep', 'getAccessToken', 'refreshAccessToken']) if (typeof store[name] === 'function') {
      const original = store[name].bind(store);
      store[name] = (...args) => ctx.guarded(() => original(...args));
    }
    return store;
  }
  async function writeBackup(p, ctx, snapshot) {
    const adapter = p.app.vault.adapter;
    const bundle = await ctx.guarded(() => buildVerifiedBackup(snapshot));
    const bytes = await ctx.guarded(() => encodeBackup(bundle));
    const directory = `.easy-sync/recovery/migration/${ctx.root}`, path = backupPath(ctx.root, bundle.bundleSha256);
    let current = '';
    for (const piece of directory.split('/')) {
      current = current ? `${current}/${piece}` : piece;
      if (!await ctx.guarded(() => adapter.exists(current))) await ctx.guarded(() => adapter.mkdir(current));
    }
    if (!await ctx.guarded(() => adapter.exists(path))) await ctx.guarded(() => adapter.writeBinary(path, bytes.slice().buffer));
    const readback = new Uint8Array(await ctx.guarded(() => adapter.readBinary(path)));
    if (readback.length !== bytes.length || !readback.every((byte, index) => byte === bytes[index]))
      fail('Сохранённая копия отличается от снимка. Существующий файл не перезаписан.');
    const proof = await ctx.guarded(() => verifyBackupWithReader(readback));
    if (proof.verified !== true || proof.bundleSha256 !== bundle.bundleSha256
      || proof.sourceFingerprint !== bundle.sourceFingerprint || proof.projectRootId !== ctx.root)
      fail('Восстановление именно этой копии не подтверждено.');
    return { bundle, proof, path };
  }
  async function readSource(p, ctx, saved) {
    await ctx.guarded(() => validateLockedPlan(saved.plan));
    if (await ctx.guarded(() => fenceDigest(saved.plan)) !== saved.planDigest) fail('Сохранённый план изменён.');
    const bytes = new Uint8Array(await ctx.guarded(() => p.app.vault.adapter.readBinary(saved.backupPath)));
    const proof = await ctx.guarded(() => verifyBackupWithReader(bytes));
    if (!same(proof, saved.proof) || proof.bundleSha256 !== saved.plan.backupBundleSha256
      || proof.sourceFingerprint !== saved.plan.sourceFingerprint || proof.projectRootId !== ctx.root
      || proof.migrationStage !== 'source') fail('Исходная копия или доказательство относятся к другому плану.');
    const bundle = await ctx.guarded(() => decodeBackup(bytes));
    // Rebuild from the saved, verified raw bytes so a modified plan/report cannot be resumed.
    const reader = new TeamShardedStore({ rootId: ctx.root,
      request: async () => fail('Подготовка плана не использует сеть.'), getAccessToken: async () => fail('Вход недоступен при восстановлении.') });
    const rootSheet = bundle.sheets.find(sheet => sheet.id === ctx.root);
    const rebuilt = await ctx.guarded(() => prepareLockedMigration({ stableSnapshot: true, remoteWrites: 0,
      migrationState: 'source', localScope: ctx.scope, fingerprint: bundle.sourceFingerprint,
      root: rootSheet.manifest, shards: bundle.project.shardIds.map(id => bundle.sheets.find(sheet => sheet.id === id).manifest),
      events: rootSheet.slots.flatMap(slot => reader.decodeCommit(reader.decodeSlot(slot.rows, 'C')).events),
      backupSnapshot: { ...bundle, fingerprint: bundle.sourceFingerprint, verifyBlobs: true, stableSnapshot: true, remoteWrites: 0 } }));
    if (!same(rebuilt, saved.plan)) fail('План не совпал с исходной копией.');
    return proof;
  }
  function atomicProofValid(proof, plan) {
    return proof?.verified === true && proof.projectRootId === plan.rootId && proof.sourceFingerprint === plan.sourceFingerprint
      && proof.operation === 'duplicate-named-range-atomic-rejection' && hash(proof.proofDigest);
  }
  function notify(p, text) { p.setTransientStatus(text); new Notice(text, 12000); }

  return {
    migrationPreviewForPlan(plan, source = {}) {
      return { ...structuredClone(plan.report), ...source, sourceSchema: 2, targetSchema: 3,
        projectRootId: plan.rootId, shardIds: [...plan.shardIds], localScope: plan.scopePath,
        snapshotFingerprint: plan.sourceFingerprint, stableSnapshot: true, remoteWrites: 0 };
    },
    migrationLiveWriteBlocker() {
      return this.pluginData?.fencedMigrationPreparations?.[this.connection?.id] ? legacyBlocker : null;
    },
    canPrepareTeamMigration() {
      return !busy(this) && this.connectionAuthMode() === 'team-v4' && this.prefs?.auto === false
        && Boolean(this.teamScopePath()) && /^[A-Za-z0-9_-]{8,128}$/.test(this.connection?.id || '')
        && !queued(this, this.connection.id) && !this.migrationLiveWriteBlocker() && !savedFor(this);
    },
    restorePreparedMigrationCandidate() {
      clearConsent(this); this.migrationPreparationEligibility = null; this.lastMigrationPreview = null;
      const saved = savedFor(this);
      if (this.connectionAuthMode() !== 'team-v4' || this.migrationLiveWriteBlocker()
        || saved?.plan?.protocol !== LOCK_PROTOCOL || saved.plan.rootId !== this.connection.id
        || saved.plan.scopePath !== this.teamScopePath()) return;
      eligibility(this, saved);
      if (!this.preparedTeamMigration()) { this.migrationPreparationEligibility = null; this.lastMigrationPreview = null; }
    },
    preparedTeamMigration() {
      const saved = savedFor(this), selected = this.migrationPreparationEligibility;
      if (this.migrationLiveWriteBlocker() || !saved || !selected || this.connectionAuthMode() !== 'team-v4'
        || selected.rootId !== this.connection.id || selected.scopePath !== this.teamScopePath()
        || selected.generation !== (this.autoSyncGeneration || 0) || saved.plan?.protocol !== LOCK_PROTOCOL
        || saved.plan.rootId !== selected.rootId || saved.plan.scopePath !== selected.scopePath
        || !hash(saved.planDigest) || !hash(saved.plan.sourceFingerprint) || !hash(saved.plan.backupBundleSha256)
        || saved.backupPath !== backupPath(selected.rootId, saved.plan.backupBundleSha256)
        || saved.proof?.verified !== true || saved.proof.projectRootId !== selected.rootId
        || saved.proof.sourceFingerprint !== saved.plan.sourceFingerprint || saved.proof.bundleSha256 !== saved.plan.backupBundleSha256
        || !['source-ready', 'locking', 'locked', 'final-ready', 'complete'].includes(saved.stage)) return null;
      if (saved.stage === 'final-ready' && (!saved.activation || !saved.finalProof
        || saved.finalBackupPath !== backupPath(selected.rootId, saved.activation.backupBundleSha256))) return null;
      return saved;
    },
    async previewTeamMigration() {
      if (!this.canPrepareTeamMigration()) fail('Для проверки выключите синхронизацию и завершите операции. Сохранённый план требует продолжения.');
      const ctx = context(this); clearConsent(this); this.migrationPreviewing = true;
      try {
        this.lastMigrationPreview = await ctx.guarded(() => readOnlySchema2MigrationPreview({ store: storeFor(this, ctx), scopePath: ctx.scope }));
        notify(this, `Проверено ${this.lastMigrationPreview.revisionCount} записей. Изменений в Google: 0.`);
        return this.lastMigrationPreview;
      } catch (error) { notify(this, error.message); return null; }
      finally { this.migrationPreviewing = false; }
    },
    async prepareTeamMigration() {
      if (!this.canPrepareTeamMigration()) fail('Для резервной копии выберите Shared, выключите автосинхронизацию и завершите текущие и ожидающие операции. Сохранённый план не заменяется.');
      const ctx = context(this);
      if (locks.has(ctx.lock)) fail('Для проекта уже выполняется операция.');
      locks.add(ctx.lock); this.migrationPreparing = true; clearConsent(this); this.migrationPreparationEligibility = null;
      try {
        const snapshot = await ctx.guarded(() => readOnlyMigrationSnapshot({ store: storeFor(this, ctx), scopePath: ctx.scope, verifyBlobs: true, includeBackupData: true }));
        const local = await writeBackup(this, ctx, snapshot.backupSnapshot);
        const plan = await ctx.guarded(() => prepareLockedMigration(snapshot));
        if (plan.rootId !== ctx.root || plan.scopePath !== ctx.scope || plan.sourceFingerprint !== local.proof.sourceFingerprint
          || plan.backupBundleSha256 !== local.proof.bundleSha256) fail('План и копия относятся к разным снимкам.');
        const saved = { plan, planDigest: await ctx.guarded(() => fenceDigest(plan)), backupPath: local.path,
          proof: local.proof, preview: { eventFingerprint: snapshot.eventFingerprint }, stage: 'source-ready', attempted: false };
        await persist(this, ctx, data => { data[bucket] ||= {}; if (data[bucket][ctx.root]) fail('Сохранённый план уже существует.'); data[bucket][ctx.root] = saved; });
        eligibility(this, saved);
        notify(this, `Восстановление проверено в памяти: ${local.proof.revisionCount} записей. Копия сохранена. Для остановки старых записей нужно первое согласие.`);
        return saved;
      } catch (error) { this.migrationPreparationEligibility = null; notify(this, error.message); return null; }
      finally { this.migrationPreparing = false; locks.delete(ctx.lock); }
    },
    canApplyTeamMigration() {
      const saved = this.preparedTeamMigration();
      return Boolean(saved && !saved.completed && !busy(this) && this.prefs?.auto === false && !queued(this, saved.plan.rootId)
        && this.migrationAllParticipantsPaused === true && this.migrationWriteApprovedFingerprint === fingerprint(saved));
    },
    async applyTeamMigration() {
      if (this.migrationLiveWriteBlocker()) fail(this.migrationLiveWriteBlocker());
      if (!this.canApplyTeamMigration()) fail('Миграция недоступна: нужны проверенная копия, точное согласие и остановленная синхронизация всех участников.');
      const saved = structuredClone(this.preparedTeamMigration()), plan = saved.plan;
      const ctx = context(this, saved, fingerprint(saved));
      if (locks.has(ctx.lock)) fail('Для проекта уже выполняется операция.');
      const patch = changes => persist(this, ctx, data => Object.assign(data[bucket][ctx.root], changes));
      locks.add(ctx.lock); this.migrationApplying = true;
      try {
        const proof = await readSource(this, ctx, saved);
        const store = storeFor(this, ctx), raw = createGoogleLockAdapter({ store, plan });
        const adapter = Object.fromEntries(['readState', 'claimLock', 'readActivation', 'claimActivation', 'verifyActivation']
          .map(name => [name, (...args) => ctx.guarded(() => raw[name](...args))]));
        if (saved.stage === 'final-ready') {
          const bytes = new Uint8Array(await ctx.guarded(() => this.app.vault.adapter.readBinary(saved.finalBackupPath)));
          const finalProof = await ctx.guarded(() => verifyBackupWithReader(bytes));
          if (!same(finalProof, saved.finalProof)) fail('Итоговая копия или доказательство изменены.');
          // Validate complete final backup/activation binding before recording or attempting any write.
          const finalBundle = await ctx.guarded(() => decodeBackup(bytes));
          const shardLocks = finalBundle.project.shardIds.map(id =>
            JSON.parse(finalBundle.sheets.find(sheet => sheet.id === id).metaCells[2][1]));
          const activation = await ctx.guarded(() => prepareSlotActivation({ plan, shardLocks,
            finalFingerprint: finalProof.sourceFingerprint, finalBackupProof: finalProof }));
          if (!same(activation, saved.activation)) fail('Итоговая активация не совпала с сохранённой копией.');
          await patch({ activationAttempted: true });
          const result = await ctx.guarded(() => executeSlotActivation({ plan, activation, adapter, approved: true,
            syncPaused: true, approvalFingerprint: activation.sourceFingerprint, backupProof: finalProof }));
          if (result?.state !== 'complete' || result.epoch !== activation.epoch) fail('Активация не подтверждена.');
          await patch({ stage: 'complete', completed: true, result });
          clearConsent(this); eligibility(this, savedFor(this));
          notify(this, 'Миграция завершена и проверена. Автосинхронизация выключена.');
          return result;
        }
        let atomicFenceProof = saved.atomicFenceProof;
        if (atomicFenceProof && !atomicProofValid(atomicFenceProof, plan)) fail('Сохранённая проверка атомарности относится к другому плану.');
        const states = [];
        for (const id of [plan.rootId, ...plan.shardIds]) states.push(await adapter.readState(id));
        if (!atomicFenceProof && states.some(state => state.state !== 'source')) fail('Без сохранённой проверки атомарности продолжение запрещено.');
        await patch({ attempted: true, stage: 'locking' });
        if (!atomicFenceProof) {
          atomicFenceProof = await ctx.guarded(() => probeGoogleLockAtomicity({ store, plan, approved: true, approvalFingerprint: plan.sourceFingerprint }));
          if (!atomicProofValid(atomicFenceProof, plan)) fail('Атомарный отказ Google не подтверждён.');
          await patch({ atomicFenceProof });
        }
        const locked = await ctx.guarded(() => executeSlotLocks({ plan, adapter, approved: true, syncPaused: true,
          approvalFingerprint: plan.sourceFingerprint, backupProof: proof, atomicFenceProof }));
        if (locked?.state !== 'locked-awaiting-final-backup' || locked.lockId !== plan.rootLock.lockId) fail('Остановка старых записей не подтверждена.');
        await patch({ stage: 'locked', locked });
        const frozen = await ctx.guarded(() => readLockedMigrationSnapshot({ store, plan }));
        const final = await writeBackup(this, ctx, frozen);
        const activation = await ctx.guarded(() => prepareSlotActivation({ plan, shardLocks: locked.shardLocks,
          finalFingerprint: frozen.fingerprint, finalBackupProof: final.proof }));
        await patch({ stage: 'final-ready', finalBackupPath: final.path, finalProof: final.proof, activation });
        clearConsent(this); eligibility(this, savedFor(this));
        notify(this, 'Старые записи остановлены. Итоговая копия проверена. Подтвердите новый SHA-256 для отдельной активации.');
        return { state: 'final-ready', activation, activationWrites: 0 };
      } catch (error) {
        clearConsent(this);
        if (this.preparedTeamMigration()) eligibility(this, savedFor(this));
        notify(this, error.message); return null;
      } finally { this.migrationApplying = false; locks.delete(ctx.lock); }
    },
    renderMigrationPreparation(el, onChanged) {
      if (this.connectionAuthMode() !== 'team-v4') return;
      const changed = () => onChanged?.();
      const invoke = async button => { button.setDisabled(true); try { await this.applyTeamMigration(); } catch (error) { this.report(error); } await changed(); };
      new Setting(el).setName('Резервная копия перед миграцией')
        .setDesc('Читает полные данные девяти таблиц, сохраняет копию и проверяет восстановление в памяти. Ничего не записывает в Google.')
        .addButton(b => b.setButtonText('Подготовить резервную копию').setDisabled(!this.canPrepareTeamMigration()).onClick(async () => {
          b.setDisabled(true); try { await this.prepareTeamMigration(); } catch (error) { this.report(error); } await changed();
        }));
      const blocker = this.migrationLiveWriteBlocker();
      if (blocker) { el.createEl('p', { text: blocker }); return; }
      const saved = this.preparedTeamMigration();
      if (!saved) {
        const preview = this.lastMigrationPreview;
        if (preview?.stableSnapshot && preview.localScope === this.teamScopePath())
          el.createEl('pre', { text: ['Проверка без записи в Google', `Shared: ${preview.localScope}`,
            `Основная таблица: ${preview.projectRootId}`, `Таблицы данных: ${(preview.shardIds || []).join(', ')}`,
            `Записей в проекте: ${preview.activeLegacyRevisionCount}; в карантине: ${preview.quarantinedRevisionCount}`,
            `SHA-256 снимка: ${preview.snapshotFingerprint}`,
            'Для разрешения миграции сначала нужна сохранённая и проверенная резервная копия.'].join('\n') });
        return;
      }
      if (saved.completed) { el.createEl('p', { text: 'Миграция завершена. Копии сохранены; автосинхронизация выключена.' }); return; }
      const final = saved.stage === 'final-ready';
      el.createEl('pre', { text: [final ? 'Этап 2: активация проекта' : 'Этап 1: остановка старых записей',
        `Shared: ${saved.plan.scopePath}`, `Основная таблица: ${saved.plan.rootId}`, `Таблицы данных: ${saved.plan.shardIds.join(', ')}`,
        `SHA-256 ${final ? 'итогового' : 'исходного'} снимка: ${fingerprint(saved)}`,
        `Записей в проекте: ${saved.plan.report?.activeLegacyRevisionCount}; в карантине: ${saved.plan.report?.quarantinedRevisionCount}. История и вложения сохраняются.`].join('\n') });
      new Setting(el).setName('Все участники остановили синхронизацию')
        .setDesc('У всех выключена автосинхронизация; никто не синхронизирует вручную.')
        .addToggle(t => t.setValue(this.migrationAllParticipantsPaused === true).onChange(value => { this.migrationAllParticipantsPaused = value; void changed(); }));
      new Setting(el).setName(final ? 'Разрешить активацию итогового снимка' : 'Разрешить остановку старых записей')
        .setDesc(final ? 'Отдельное согласие для нового SHA-256: включить новый протокол проекта. Старое согласие не действует.'
          : 'Согласие для исходного SHA-256: проверить атомарный отказ Google, затем необратимо остановить старые записи в основной таблице и восьми сегментах. Старые клиенты больше не смогут записывать.')
        .addToggle(t => t.setValue(this.migrationWriteApprovedFingerprint === fingerprint(saved)).onChange(value => {
          this.migrationWriteApprovedFingerprint = value ? fingerprint(saved) : null; void changed();
        }));
      new Setting(el).setName(final ? 'Активировать проект' : 'Остановить старые записи')
        .setDesc('Повторно проверяет сохранённые копии и тот же план. Синхронизация автоматически не запускается.')
        .addButton(b => b.setButtonText(final ? 'Активировать проект' : saved.attempted ? 'Продолжить остановку' : 'Остановить старые записи')
          .setDisabled(!this.canApplyTeamMigration()).onClick(() => invoke(b)));
    }
  };
}
module.exports = { createLockedMigrationMethods };
