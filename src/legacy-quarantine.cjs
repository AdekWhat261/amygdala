'use strict';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUARANTINE_PROTOCOL = 'preserve-hidden-v1';
const PATH_MAP_PROTOCOL = 'prefix-rebase-v1';
const MAX_QUARANTINE_BYTES = 40000;
const { normalizeFolderPath } = require('./planner.cjs');
const { validateRevision, materialize } = require('./journal.cjs');

function validateLegacyQuarantine(root) {
  const marker = root?.legacyQuarantine;
  if (marker === undefined) return new Set();
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || marker.protocol !== QUARANTINE_PROTOCOL
    || !Array.isArray(marker.revisionIds) || marker.revisionIds.length > 1536
    || new TextEncoder().encode(JSON.stringify(marker)).byteLength > MAX_QUARANTINE_BYTES) {
    throw new Error('Invalid legacy quarantine marker');
  }
  const ids = marker.revisionIds;
  if (ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && ids[index - 1] >= id)) {
    throw new Error('Invalid legacy quarantine revision IDs');
  }
  return new Set(ids);
}

function validateLegacyPathMap(root) {
  const marker = root?.legacyPathMap;
  if (marker === undefined) return null;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || marker.protocol !== PATH_MAP_PROTOCOL
    || typeof marker.prefix !== 'string' || !Array.isArray(marker.revisionIds) || marker.revisionIds.length > 1536
    || new TextEncoder().encode(JSON.stringify(marker)).byteLength > MAX_QUARANTINE_BYTES) {
    throw new Error('Invalid legacy path map');
  }
  const prefix = normalizeFolderPath(marker.prefix);
  if (prefix !== marker.prefix) throw new Error('Non-canonical legacy path map prefix');
  const ids = marker.revisionIds;
  if (ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && ids[index - 1] >= id)) {
    throw new Error('Invalid legacy path map revision IDs');
  }
  const quarantined = validateLegacyQuarantine(root);
  if (ids.some(id => quarantined.has(id))) throw new Error('Legacy path map overlaps quarantine');
  return { prefix, revisionIds: new Set(ids) };
}

function mapLegacyPaths(events, root) {
  const hidden = validateLegacyQuarantine(root);
  const mapping = validateLegacyPathMap(root);
  const byId = new Map(events.map(event => [event.id, event]));
  if ([...hidden].some(id => !byId.has(id)) || (mapping && [...mapping.revisionIds].some(id => !byId.has(id)))) {
    throw new Error('Legacy migration marker references missing history');
  }
  const mappedEvents = [];
  for (const event of events) {
    if (mapping?.revisionIds.has(event.id)) {
      const prefix = `${mapping.prefix}/`;
      if (!event.path.startsWith(prefix)) throw new Error('Mapped legacy path escaped its selected folder');
      const mapped = validateRevision({ ...event, path: event.path.slice(prefix.length) });
      mappedEvents.push(mapped);
    } else mappedEvents.push(event);
  }
  return { hidden, mappedEvents };
}

function visibleEvents(events, root) {
  return validateMigratedEventSets(events, root).visible;
}

function validateMigratedEventSets(events, root) {
  const { hidden, mappedEvents } = mapLegacyPaths(events, root);
  const active = mappedEvents.filter(event => !hidden.has(event.id));
  const quarantined = mappedEvents.filter(event => hidden.has(event.id));
  // Quarantined paths stay in the old vault-relative namespace. Validate them
  // separately from project-relative events, since equal path strings can be
  // distinct files on opposite sides of the selected folder boundary.
  const activeHeads = materialize(active);
  const quarantinedHeads = materialize(quarantined);
  return { hidden, mappedEvents, visible: active, activeHeads, quarantinedHeads };
}

module.exports = { QUARANTINE_PROTOCOL, PATH_MAP_PROTOCOL, MAX_QUARANTINE_BYTES,
  validateLegacyQuarantine, validateLegacyPathMap, mapLegacyPaths, validateMigratedEventSets, visibleEvents };
