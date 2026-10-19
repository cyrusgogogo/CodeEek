import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const absoluteDirectory = z.string().min(1).refine(value => value === value.trim() && !value.includes('\0') && path.isAbsolute(value) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)), '档案目录必须是非空的本机绝对路径，且不能含首尾空白；Windows 需包含盘符，不支持 UNC');
export const Config = z.object({ dataDir: absoluteDirectory.optional().describe('阅读档案的绝对目录；不要选择源码仓库目录。更改已运行实例的目录需要重启 DSH。') }).strict().default({});

/** Resolve only explicit documented inputs; never let an installation CWD choose the archive root. */
export function resolveDataDirectory(config, env = process.env, home = homedir()) {
  let directory, source;
  if (config.dataDir !== undefined) { directory = config.dataDir; source = 'config.dataDir'; }
  else if (env.DSH_CODE_READING_HOME !== undefined) { directory = env.DSH_CODE_READING_HOME; source = 'DSH_CODE_READING_HOME'; }
  else {
    const base = env.DSH_HOME ?? path.join(home, '.dsh');
    const checked = absoluteDirectory.safeParse(base);
    if (!checked.success) throw Object.assign(new Error('DSH_HOME 必须是非空的绝对路径；请修正环境变量后重启 DSH'), { code: 'INVALID_DATA_DIR' });
    directory = path.join(base, 'code-reading'); source = env.DSH_HOME === undefined ? 'default' : 'DSH_HOME';
  }
  if (!absoluteDirectory.safeParse(directory).success) throw Object.assign(new Error(`${source} 必须是非空的绝对路径；请修正配置后重启 DSH`), { code: 'INVALID_DATA_DIR' });
  return { directory: path.resolve(directory), source };
}
