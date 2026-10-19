import React from 'react';
import { getFileIconName, getFolderIconName } from './file-icons.mjs';
import { iconAssets } from './icons/icon-assets.mjs';

export function EntryIcon({ path, folder = false, open = false, root = false }) {
  const name = folder ? getFolderIconName(path, { open, root }) : getFileIconName(path);
  return <img className="cr-entry-icon" src={iconAssets[name] ?? iconAssets.file} data-icon={name} width="20" height="20" alt="" aria-hidden="true" draggable="false" />;
}
