/**
 * Skill Loader for Cal Gateway
 *
 * Loads skills from the distributable skills/ directory.
 * Each skill is a folder with a SKILL.md file containing instructions.
 *
 * Skills are instructions for Claude on how to perform complex tasks
 * using the available tools.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SKILLS_DIR } from './paths.js';

// Cache of loaded skills
let skillsCache = null;

/**
 * Load all skills from the skills directory
 * @returns {Map<string, object>} Map of skill name → skill data
 */
export function loadSkills() {
  if (skillsCache) {
    return skillsCache;
  }

  skillsCache = new Map();

  if (!existsSync(SKILLS_DIR)) {
    console.log('[Skills] No skills directory found');
    return skillsCache;
  }

  const folders = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const folder of folders) {
    const skillPath = join(SKILLS_DIR, folder, 'SKILL.md');

    if (!existsSync(skillPath)) {
      continue;
    }

    try {
      const content = readFileSync(skillPath, 'utf8');
      const skill = parseSkill(content, folder);

      if (skill) {
        skillsCache.set(skill.name, skill);
        console.log(`[Skills] Loaded: ${skill.name}`);
      }
    } catch (err) {
      console.error(`[Skills] Failed to load ${folder}:`, err.message);
    }
  }

  console.log(`[Skills] ${skillsCache.size} skills loaded`);
  return skillsCache;
}

/**
 * Parse a SKILL.md file into a skill object
 */
function parseSkill(content, folderName) {
  // Extract frontmatter if present (---\n...\n---)
  let name = folderName;
  let description = '';
  let prompt = content;

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    prompt = frontmatterMatch[2].trim();

    // Parse frontmatter
    for (const line of frontmatter.split('\n')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();

      if (key.trim() === 'name') {
        name = value;
      } else if (key.trim() === 'description') {
        description = value;
      }
    }
  }

  return {
    name,
    description,
    prompt,
    folder: folderName,
  };
}

/**
 * Get a skill by name
 * @param {string} name - Skill name (e.g., 'handoff', 'consolidate')
 * @returns {object|null} Skill object or null if not found
 */
export function getSkill(name) {
  const skills = loadSkills();
  return skills.get(name) || null;
}

/**
 * Get all available skill names
 * @returns {string[]} Array of skill names
 */
export function getSkillNames() {
  const skills = loadSkills();
  return Array.from(skills.keys());
}

/**
 * Check if a skill exists
 * @param {string} name - Skill name
 * @returns {boolean}
 */
export function hasSkill(name) {
  const skills = loadSkills();
  return skills.has(name);
}

/**
 * Reload skills from disk (clear cache)
 */
export function reloadSkills() {
  skillsCache = null;
  return loadSkills();
}

/**
 * Get skill prompt ready to send to Claude
 * Prepends context about the skill invocation
 * @param {string} name - Skill name
 * @returns {string|null} Formatted prompt or null if skill not found
 */
export function getSkillPrompt(name) {
  const skill = getSkill(name);

  if (!skill) {
    return null;
  }

  // Return the skill prompt with a header
  return `[Skill Invoked: /${name}]

${skill.prompt}`;
}
