import { stat } from "node:fs/promises";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { getCodeIntelPaths, projectDataDir, validateProjectName } from "./paths.js";
import type { Stack } from "./schemas.js";

export type RegisteredProject = {
  name: string;
  path: string;
  stack: Stack;
  gitnexus_repo?: string;
  created_at: string;
  updated_at: string;
};

export type RegisterProjectInput = {
  name: string;
  path: string;
  stack: Stack;
  gitnexus_repo?: string;
};

type RegistryFile = {
  projects: RegisteredProject[];
};

const VALID_STACKS = new Set<Stack>([
  "java-spring-mybatis",
  "java-spring",
  "java-dubbo-mybatis",
  "java-generic"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegistryStringField(
  project: Record<string, unknown>,
  index: number,
  field: keyof RegisteredProject
): string {
  const value = project[field];
  if (typeof value !== "string") {
    throw new Error(`registry.json 格式无效：projects[${index}].${field} 必须是字符串`);
  }
  return value;
}

function validateRegisteredProject(project: unknown, index: number): RegisteredProject {
  if (!isRecord(project)) {
    throw new Error(`registry.json 格式无效：projects[${index}] 必须是对象`);
  }

  const name = assertRegistryStringField(project, index, "name");
  try {
    validateProjectName(name);
  } catch (error) {
    throw new Error(`registry.json 格式无效：projects[${index}].name ${(error as Error).message}`);
  }

  const path = assertRegistryStringField(project, index, "path");
  const stack = assertRegistryStringField(project, index, "stack");
  if (!VALID_STACKS.has(stack as Stack)) {
    throw new Error(`registry.json 格式无效：projects[${index}].stack 不支持：${stack}`);
  }
  const gitnexusRepo = project.gitnexus_repo;
  if (gitnexusRepo !== undefined && typeof gitnexusRepo !== "string") {
    throw new Error(`registry.json 格式无效：projects[${index}].gitnexus_repo 必须是字符串`);
  }

  return {
    name,
    path,
    stack: stack as Stack,
    ...(gitnexusRepo ? { gitnexus_repo: gitnexusRepo } : {}),
    created_at: assertRegistryStringField(project, index, "created_at"),
    updated_at: assertRegistryStringField(project, index, "updated_at")
  };
}

function validateRegistryFile(value: unknown): RegistryFile {
  if (!isRecord(value)) {
    throw new Error("registry.json 格式无效：根节点必须是对象");
  }
  if (!Array.isArray(value.projects)) {
    throw new Error("registry.json 格式无效：projects 必须是数组");
  }

  return {
    projects: value.projects.map((project, index) => validateRegisteredProject(project, index))
  };
}

export function createProjectRegistry(options: { home?: string } = {}) {
  const paths = getCodeIntelPaths(options.home);

  async function readRegistry(): Promise<RegistryFile> {
    return validateRegistryFile(await readJsonFile<unknown>(paths.registryFile, { projects: [] }));
  }

  async function writeRegistry(registry: RegistryFile): Promise<void> {
    await ensureDir(paths.home);
    await ensureDir(paths.projectsDir);
    await ensureDir(paths.logsDir);
    await writeJsonFile(paths.registryFile, registry);
  }

  async function register(input: RegisterProjectInput): Promise<RegisteredProject> {
    const name = validateProjectName(input.name);
    if (!VALID_STACKS.has(input.stack)) {
      throw new Error(`技术栈不支持：${input.stack}`);
    }
    const statResult = await stat(input.path);
    if (!statResult.isDirectory()) throw new Error(`项目路径不是目录：${input.path}`);

    const registry = await readRegistry();
    const now = new Date().toISOString();
    const existing = registry.projects.find((project) => project.name === name);
    const project: RegisteredProject = {
      name,
      path: input.path,
      stack: input.stack,
      ...(input.gitnexus_repo ? { gitnexus_repo: input.gitnexus_repo } : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    registry.projects = registry.projects
      .filter((item) => item.name !== name)
      .concat(project);
    await writeRegistry(registry);
    await ensureDir(projectDataDir(paths.home, name));
    return project;
  }

  async function get(name: string): Promise<RegisteredProject | undefined> {
    const registry = await readRegistry();
    return registry.projects.find((project) => project.name === name);
  }

  async function list(): Promise<RegisteredProject[]> {
    const registry = await readRegistry();
    return registry.projects;
  }

  async function exists(name: string): Promise<boolean> {
    const project = await get(name);
    if (!project) return false;
    try {
      return (await stat(project.path)).isDirectory();
    } catch {
      return false;
    }
  }

  return {
    register,
    get,
    list,
    exists
  };
}
