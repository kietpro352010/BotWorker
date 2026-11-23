'use strict';

const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  path.join(__dirname, '..', 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'bedrock'),
  path.join(__dirname, '..', 'node_modules', 'minecraft-data', 'data', 'bedrock')
];

function pruneBedrockVersions() {
  const bedrockDir = candidates.find((candidate) => fs.existsSync(candidate));
  if (!bedrockDir) return;

  const commonDir = path.join(bedrockDir, 'common');
  const featuresFile = path.join(commonDir, 'features.json');
  if (!fs.existsSync(featuresFile)) {
    console.log('[postinstall] Skipping Bedrock data pruning: common/features.json is missing.');
    return;
  }

  try {
    JSON.parse(fs.readFileSync(featuresFile, 'utf8'));
  } catch (error) {
    console.warn('[postinstall] Skipping Bedrock data pruning: common/features.json is invalid.', error.message);
    return;
  }

  const root = path.resolve(bedrockDir);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'common' || !entry.isDirectory()) continue;
    const target = path.resolve(root, entry.name);
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[postinstall] Could not remove optional Bedrock data ${entry.name}:`, error.message);
    }
  }

  console.log('[postinstall] Removed unused Bedrock version data; retained common/features.json.');
}

const pcCandidates = [
  path.join(__dirname, '..', 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc'),
  path.join(__dirname, '..', 'node_modules', 'minecraft-data', 'data', 'pc')
];

function pruneHeavyPcRecipes() {
  const pcDir = pcCandidates.find((candidate) => fs.existsSync(candidate));
  if (!pcDir) return;
  const root = path.resolve(pcDir);
  let slimmed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const recipesFile = path.resolve(root, entry.name, 'recipes.json');
    if (!recipesFile.startsWith(`${root}${path.sep}`) || !fs.existsSync(recipesFile)) continue;
    try {
      const stat = fs.statSync(recipesFile);
      if (stat.size > 16) {
        fs.writeFileSync(recipesFile, '{}', 'utf8');
        slimmed += 1;
      }
    } catch (_) {}
  }
  if (slimmed > 0) {
    console.log(`[postinstall] Slimmed ${slimmed} unused PC recipes.json files to reduce disk/memory footprint.`);
  }
}

try {
  pruneBedrockVersions();
  pruneHeavyPcRecipes();
} catch (error) {
  console.warn('[postinstall] Optional data cleanup failed:', error.message);
}
