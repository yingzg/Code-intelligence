import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CodeIntelPaths = {
  home: string;
  registryFile: string;
  configFile: string;
  projectsDir: string;
  logsDir: string;
};

export function resolveCodeIntelHome(env = process.env): string {
  return env.CODE_INTEL_HOME && env.CODE_INTEL_HOME.trim().length > 0
    ? resolve(env.CODE_INTEL_HOME.trim())
    : join(homedir(), ".code-intelligence");
}

export function getCodeIntelPaths(home = resolveCodeIntelHome()): CodeIntelPaths {
  return {
    home,
    registryFile: join(home, "registry.json"),
    configFile: join(home, "config.json"),
    projectsDir: join(home, "projects"),
    logsDir: join(home, "logs")
  };
}

export function projectDataDir(home: string, projectName: string): string {
  return join(home, "projects", validateProjectName(projectName));
}

export function validateProjectName(name: string): string {
  if (typeof name !== "string") {
    throw new Error("项目名无效：必须是字符串");
  }
  if (name !== name.trim()) {
    throw new Error("项目名无效：不能包含前后空白");
  }
  if (name === "." || name === "..") {
    throw new Error("项目名无效：不能为 . 或 ..");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error("项目名无效：仅允许 1-128 位字母、数字、点、下划线或连字符，且必须以字母或数字开头");
  }
  return name;
}
