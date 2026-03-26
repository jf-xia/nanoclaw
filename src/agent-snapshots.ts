import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';
import { ScheduledTask } from './types.js';

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface TaskSnapshotRow {
  id: string;
  groupFolder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

export function buildTaskSnapshotRows(
  tasks: ScheduledTask[],
): TaskSnapshotRow[] {
  return tasks.map((task) => ({
    id: task.id,
    groupFolder: task.group_folder,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    status: task.status,
    next_run: task.next_run,
  }));
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: TaskSnapshotRow[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((task) => task.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function syncAgentSnapshots(options: {
  groupFolder: string;
  isMain: boolean;
  tasks: ScheduledTask[];
  availableGroups?: AvailableGroup[];
}): TaskSnapshotRow[] {
  const taskRows = buildTaskSnapshotRows(options.tasks);
  writeTasksSnapshot(options.groupFolder, options.isMain, taskRows);

  if (options.availableGroups) {
    writeGroupsSnapshot(
      options.groupFolder,
      options.isMain,
      options.availableGroups,
    );
  }

  return taskRows;
}