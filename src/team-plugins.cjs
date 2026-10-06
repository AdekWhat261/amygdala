'use strict';

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX = 200;

function validateCatalog(value) {
  if (!value || typeof value !== 'object' || value.schema !== 1 || !Array.isArray(value.plugins) || value.plugins.length > MAX) {
    throw new Error('Некорректный каталог командных плагинов.');
  }
  const seen = new Set();
  return value.plugins.map(plugin => {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string' || !ID.test(plugin.id)
      || typeof plugin.version !== 'string' || !VERSION.test(plugin.version)
      || typeof plugin.name !== 'string' || !plugin.name.trim() || plugin.name.length > 120
      || typeof plugin.author !== 'string' || plugin.author.length > 120
      || typeof plugin.description !== 'string' || plugin.description.length > 500) {
      throw new Error('В каталоге есть плагин с некорректными данными.');
    }
    if (plugin.id === 'amygdala-connection' || seen.has(plugin.id)) throw new Error('Каталог содержит повторяющийся или служебный плагин.');
    seen.add(plugin.id);
    const clean = { id: plugin.id, version: plugin.version, name: plugin.name.trim(), author: plugin.author.trim(), description: plugin.description.trim() };
    if (plugin.proposedById !== undefined && (typeof plugin.proposedById !== 'string' || plugin.proposedById.length > 256)) throw new Error('Некорректный автор предложения плагина.');
    if (plugin.proposedByName !== undefined && (typeof plugin.proposedByName !== 'string' || plugin.proposedByName.length > 120)) throw new Error('Некорректное имя автора предложения.');
    if (plugin.proposedById) clean.proposedById = plugin.proposedById;
    if (plugin.proposedByName) clean.proposedByName = plugin.proposedByName;
    return clean;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { validateCatalog };
