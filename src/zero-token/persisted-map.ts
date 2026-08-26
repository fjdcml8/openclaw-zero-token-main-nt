/**
 * PersistedMap — 自动持久化到磁盘的键值存储
 *
 * 用于保存 Web 模型的会话/对话 ID，使得进程重启后仍能恢复已有对话。
 * 数据以 JSON 格式写入指定文件路径，写入操作有 1 秒防抖。
 */

import fs from "node:fs";
import path from "node:path";

export class PersistedMap {
  private map: Map<string, string>;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.map = new Map();
    this.load();
  }

  /** 从磁盘加载已保存的会话数据 */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (typeof data === "object" && data !== null) {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === "string") {
              this.map.set(key, value);
            }
          }
        }
        console.log(
          `[PersistedMap] Loaded ${this.map.size} sessions from ${this.filePath}`,
        );
      }
    } catch (err) {
      console.warn(
        `[PersistedMap] Failed to load from ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 将数据写入磁盘（防抖 1 秒） */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 1000);
  }

  /**
   * 立即写入磁盘（供进程退出前调用）
   */
  flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, string> = {};
      for (const [key, value] of this.map) {
        obj[key] = value;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.warn(
        `[PersistedMap] Failed to save to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
    this.scheduleSave();
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    const result = this.map.delete(key);
    if (result) {
      this.scheduleSave();
    }
    return result;
  }

  clear(): void {
    this.map.clear();
    this.scheduleSave();
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[string, string]> {
    return this.map.entries();
  }
}
