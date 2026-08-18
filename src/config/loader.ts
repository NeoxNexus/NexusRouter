import { parse as parseYaml } from "yaml";
import { readFile } from "fs/promises";
import { ConfigSchema, type Config } from "./schema.js";
import { getDefaultConfigPath } from "./default-config.js";

export { ConfigSchema } from "./schema.js";
export type { Config } from "./schema.js";
export {
  getDefaultConfigPath,
  ensureConfigExists,
  DEFAULT_CONFIG_YAML,
} from "./default-config.js";

function resolveEnvVars(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    // 支持多种环境变量格式：
    // ${VAR:-default} - 带默认值
    // ${VAR} - 标准格式
    // $VAR - 简单格式

    // 1. 默认值格式 ${VAR:-default}
    const withDefault = obj.match(/^\$\{([^}:]+):-(.*)\}$/);
    if (withDefault) {
      return process.env[withDefault[1]] || withDefault[2];
    }

    // 2. 标准格式 ${VAR}
    const standard = obj.match(/^\$\{([^}]+)\}$/);
    if (standard) {
      const envVar = standard[1];
      const value = process.env[envVar];
      if (value === undefined) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return value;
    }

    // 3. 简单格式 $VAR
    const simple = obj.match(/^\$(\w+)$/);
    if (simple) {
      const envVar = simple[1];
      const value = process.env[envVar];
      if (value === undefined) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return value;
    }

    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }

  return obj;
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const pathToLoad = configPath || getDefaultConfigPath();

  const fileContent = await readFile(pathToLoad, "utf-8");
  const parsed = parseYaml(fileContent);

  const resolved = resolveEnvVars(parsed) as Record<string, unknown>;

  const result = ConfigSchema.safeParse(resolved);

  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    }));
    throw new Error(
      `Configuration validation failed:\n${errors.map((e) => `- ${e.path}: ${e.message}`).join("\n")}`,
    );
  }

  return result.data;
}
