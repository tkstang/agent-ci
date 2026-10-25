import { doctorCommand } from '@agent-ci/commands/doctor.js';
import { modelsCommand } from '@agent-ci/commands/models.js';
import { routeCommand } from '@agent-ci/commands/route.js';
import { runCommand } from '@agent-ci/commands/run.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { validateCommand } from '@agent-ci/commands/validate.js';

/** Registered subcommands, in help order. */
export const COMMANDS: readonly CommandSpec[] = [
  runCommand,
  routeCommand,
  modelsCommand,
  doctorCommand,
  validateCommand,
];
