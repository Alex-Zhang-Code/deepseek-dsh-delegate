import Ajv2020 from 'ajv/dist/2020.js';
import { taskSchema, validateLocalTask } from './task-runner.mjs';

export const builderSchema = {
  type: 'object', additionalProperties: false,
  required: ['task_id', 'objective', 'working_directory', 'acceptance_criteria'],
  properties: {
    ...Object.fromEntries(['task_id', 'objective', 'working_directory', 'mode', 'allowed_paths',
      'forbidden_actions', 'context', 'acceptance_criteria', 'timeout_seconds', 'metadata']
      .map(key => [key, taskSchema.properties[key]])),
    output_format: { enum: ['text', 'markdown', 'json'], default: 'markdown' },
    output_requirements: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};
const ajv = new Ajv2020({ allErrors: true, strict: false });
const valid = ajv.compile(builderSchema);

export function assertTask(task) {
  const error = validateLocalTask(task);
  if (error) throw new Error(`INVALID_TASK: ${error}`);
  return task;
}

export function buildTask(input) {
  if (!valid(input)) throw new Error(`INVALID_TASK: ${ajv.errorsText(valid.errors)}`);
  const { output_format = 'markdown', output_requirements = [], ...fields } = input;
  return assertTask({ schema_version: '1.0', mode: 'read_only', allowed_paths: [],
    forbidden_actions: [], context: '', timeout_seconds: 120, metadata: {}, ...fields,
    expected_output: { format: output_format, requirements: output_requirements } });
}
