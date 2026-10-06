'use strict';

const VERIFIED_WINDOW_MS = 5 * 60 * 1000;

function projectLabel(connection) {
  if (connection.kind !== 'team') return 'Личный проект подключён';
  const version = Number.isInteger(connection.version) ? connection.version : 3;
  return `Командный проект v${version} подключён`;
}

function connectionStatus({ connection = null, credentialPresent = null, authRejected = false, verifiedAt = null, verifiedKind = 'sync', now = Date.now() } = {}) {
  if (!connection) return { state: 'no-project', text: 'Проект не подключён' };
  const prefix = projectLabel(connection);
  if (credentialPresent === false) return { state: 'missing', text: `${prefix}; войдите в Google` };
  if (credentialPresent !== true) return { state: 'unknown', text: `${prefix}; состояние входа Google недоступно` };
  if (authRejected) return { state: 'rejected', text: `${prefix}; Google отклонил вход, подключитесь повторно` };
  if (Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= VERIFIED_WINDOW_MS) {
    return { state: 'verified', text: verifiedKind === 'metadata'
      ? `${prefix}; проверено чтение сведений основной таблицы; синхронизация не запускалась`
      : `${prefix}; доступ к проекту недавно проверен` };
  }
  return { state: 'unverified', text: `${prefix}; вход сохранён, доступ Google ещё не проверен` };
}

module.exports = { VERIFIED_WINDOW_MS, connectionStatus };
