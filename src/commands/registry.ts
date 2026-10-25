import { digestCommand } from '@agent-ci/commands/digest.js';
import { doctorCommand } from '@agent-ci/commands/doctor.js';
import { harnessCommand } from '@agent-ci/commands/harness.js';
import { modelsCommand } from '@agent-ci/commands/models.js';
import { notifyCommand } from '@agent-ci/commands/notify.js';
import { presetCommand } from '@agent-ci/commands/preset.js';
import { publishCommand } from '@agent-ci/commands/publish.js';
import { reviewCommand } from '@agent-ci/commands/review.js';
import { routeCommand } from '@agent-ci/commands/route.js';
import { runCommand } from '@agent-ci/commands/run.js';
import { skillsCommand } from '@agent-ci/commands/skills.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { validateCommand } from '@agent-ci/commands/validate.js';
import { workspaceCommand } from '@agent-ci/commands/workspace.js';

/** Registered subcommands, in help order. */
export const COMMANDS: readonly CommandSpec[] = [
  runCommand,
  routeCommand,
  modelsCommand,
  doctorCommand,
  validateCommand,
  harnessCommand,
  skillsCommand,
  publishCommand,
  reviewCommand,
  presetCommand,
  notifyCommand,
  workspaceCommand,
  digestCommand,
];
