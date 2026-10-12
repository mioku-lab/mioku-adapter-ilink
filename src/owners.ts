import { botConfig, updateMiokuConfig } from "mioku";

import type { Logger } from "mioku";
import type { AccountStore } from "./store";
import { errorMessage } from "./util";

export interface OwnerSyncOptions {
  /** 实例配置的 master 开关 */
  readonly enabled: boolean;
  /** 扫码登录的微信用户 id */
  readonly userId?: string;
  readonly store: AccountStore;
  readonly logger: Logger;
}

const addOwner = async (userId: string): Promise<void> => {
  if (botConfig.owners.includes(userId)) return;
  await updateMiokuConfig((config) => {
    config.owners = [...config.owners, userId];
  });
};

const removeOwner = async (userId: string): Promise<void> => {
  if (!botConfig.owners.includes(userId)) return;
  await updateMiokuConfig((config) => {
    config.owners = config.owners.filter((id) => id !== userId);
  });
};

/**
 * 维护 `mioku.owners`：master 打开时写入扫码用户，关闭时移除自己写入的那个。
 * 手动加进 owners 的 id 不会被移除。
 */
export const syncManagedOwner = async (
  options: OwnerSyncOptions,
): Promise<void> => {
  const { enabled, userId, store, logger } = options;
  const managed = store.loadManagedOwner();
  try {
    if (enabled) {
      if (!userId) {
        logger.warn("登录响应没有扫码用户 id，无法写入 mioku.owners");
        return;
      }
      const changed = !botConfig.owners.includes(userId);
      await addOwner(userId);
      if (managed !== userId) store.saveManagedOwner(userId);
      if (changed) logger.info(`已把扫码用户 ${userId} 设为主人（mioku.owners）`);
      return;
    }
    if (managed) {
      const changed = botConfig.owners.includes(managed);
      await removeOwner(managed);
      store.saveManagedOwner(undefined);
      if (changed)
        logger.info(`已取消扫码用户 ${managed} 的主人权限（mioku.owners）`);
      return;
    }
    if (userId && !botConfig.owners.includes(userId))
      logger.info(
        `扫码用户 ${userId} 不是主人；把实例的 master 设为 true 会自动写入 mioku.owners`,
      );
  } catch (err) {
    logger.warn(`同步 mioku.owners 失败: ${errorMessage(err)}`);
  }
};
