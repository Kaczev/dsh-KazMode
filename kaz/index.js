import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'kaz';
export const inject = ['systemPrompt', 'skills'];

const promptUrl = new URL('./prompt.md', import.meta.url);
const skillsDirectory = new URL('./skills/', import.meta.url);

// This packaged skill has two plain, single-line frontmatter fields. Fail loudly
// if its format changes rather than silently publishing incomplete metadata.
function readSkill(directoryName) {
  const skillDirectory = new URL(`${directoryName}/`, skillsDirectory);
  const skillUrl = new URL('SKILL.md', skillDirectory);
  const source = readFileSync(skillUrl, 'utf8');
  const match = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
  if (!match || match[1] !== directoryName) {
    throw new Error('Kaz skill must contain matching name and description plain frontmatter fields');
  }
  const metadata = { name: match[1], description: match[2] };
  return {
    ...metadata,
    source: 'runtime',
    path: fileURLToPath(skillUrl),
    resourceBase: { kind: 'directory', path: fileURLToPath(skillDirectory) },
    invocation: { modelInvocable: true, userInvocable: true },
    metadata,
    content: match[3],
  };
}

// Mount this plugin in the Host layer, not in an agent preset. The native
// persona and all preset-owned tools, policies, and skills remain untouched.
export function apply(ctx) {
  const text = readFileSync(promptUrl, 'utf8');
  const skills = readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().map(readSkill);
  const before = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX');
  const after = ctx.systemPrompt.getSectionOrder('PLAN_POLICY');
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'kaz:preferences',
    order: (before + after) / 2,
    text,
    interpolate: false,
  }));
  for (const skill of skills) ctx.effect(() => ctx.skills.register(skill));
}
