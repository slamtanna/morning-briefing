'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUNDLED_CLAUDE_MD = path.join(os.homedir(), 'Claude Context', 'CLAUDE.md');
const CLAUDE_MD_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'CLAUDE.md')
  : BUNDLED_CLAUDE_MD;
const REQUIRED_SECTIONS = ['## People'];
const TARGET_SECTIONS = ['## People', '## Terms', '## Projects', '## Preferences'];

/**
 * Extract specific sections from CLAUDE.md content.
 * Stops extraction when it hits ## gstack.
 *
 * @param {string} content - Raw CLAUDE.md file content
 * @returns {{ People: string, Terms: string, Projects: string, Preferences: string }}
 */
function extractSections(content) {
  const result = { People: '', Terms: '', Projects: '', Preferences: '' };
  const lines = content.split('\n');

  let currentSection = null;
  let sectionLines = [];
  const sectionMap = {
    '## People': 'People',
    '## Terms': 'Terms',
    '## Projects': 'Projects',
    '## Preferences': 'Preferences',
  };

  function flushSection() {
    if (currentSection) {
      result[currentSection] = sectionLines.join('\n').trim();
    }
    sectionLines = [];
  }

  for (const line of lines) {
    // Stop at gstack — never inject gstack skill instructions
    if (line.startsWith('## gstack')) {
      flushSection();
      currentSection = null; // prevent the post-loop flushSection from overwriting
      break;
    }

    if (sectionMap[line.trim()]) {
      flushSection();
      currentSection = sectionMap[line.trim()];
    } else if (line.startsWith('## ') && currentSection) {
      // Hit a different H2 heading — close current section
      flushSection();
      currentSection = null;
    } else if (currentSection) {
      sectionLines.push(line);
    }
  }
  flushSection();

  return result;
}

/**
 * Load and validate CLAUDE.md. Throws on missing required sections.
 * Priority: content string > CLAUDE_MD_B64 env var > file path.
 *
 * @param {string} [filePath] - Override path (for tests)
 * @param {string} [content]  - Raw CLAUDE.md content (skips file read)
 * @returns {{ People: string, Terms: string, Projects: string, Preferences: string }}
 */
function loadContext(filePath, content) {
  if (!content) {
    if (process.env.CLAUDE_MD_B64) {
      content = Buffer.from(process.env.CLAUDE_MD_B64, 'base64').toString('utf8');
    } else {
      let defaultReadPath = BUNDLED_CLAUDE_MD;
      if (process.env.DATA_DIR) {
        const volumePath = path.join(process.env.DATA_DIR, 'CLAUDE.md');
        if (fs.existsSync(volumePath)) defaultReadPath = volumePath;
      }
      const targetPath = filePath || defaultReadPath;
      try {
        content = fs.readFileSync(targetPath, 'utf8');
      } catch (err) {
        throw new Error(`Could not read CLAUDE.md at ${targetPath}: ${err.message}`);
      }
    }
  }

  const sections = extractSections(content);

  for (const heading of REQUIRED_SECTIONS) {
    const key = heading.replace('## ', '');
    if (!sections[key]) {
      throw new Error(`CLAUDE.md missing required section: ${heading}`);
    }
  }

  return sections;
}

/**
 * Format extracted sections into the system prompt block.
 */
function buildOrgContext(sections) {
  const parts = [];
  if (sections.People) parts.push(`## People\n${sections.People}`);
  if (sections.Terms) parts.push(`## Terms\n${sections.Terms}`);
  if (sections.Projects) parts.push(`## Projects\n${sections.Projects}`);
  if (sections.Preferences) parts.push(`## Preferences\n${sections.Preferences}`);
  return parts.join('\n\n');
}

module.exports = { loadContext, buildOrgContext, CLAUDE_MD_PATH };
