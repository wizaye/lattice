import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { isTauri } from './tauriApi';

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_notes?: string;
  download_url?: string;
  published_at?: string;
}

export interface UpdateSettings {
  auto_check: boolean;
  check_interval_hours: number;
  notify_on_update: boolean;
  auto_download: boolean;
  channel: 'Stable' | 'Beta' | 'Nightly';
}

/**
 * Check for updates
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return await invoke('ota_check_for_updates');
}

/**
 * Download and install update
 */
export async function downloadAndInstall(): Promise<string> {
  if (!isTauri()) return 'Not available in browser mode';
  return await invoke('ota_download_and_install');
}

/**
 * Get update settings
 */
export async function getUpdateSettings(): Promise<UpdateSettings | null> {
  if (!isTauri()) return null;
  return await invoke('ota_get_settings');
}

/**
 * Save update settings
 */
export async function setUpdateSettings(settings: UpdateSettings): Promise<void> {
  if (!isTauri()) return;
  return await invoke('ota_set_settings', { settings });
}

/**
 * Get release notes for a version
 */
export async function getReleaseNotes(version: string): Promise<string> {
  if (!isTauri()) return '';
  return await invoke('ota_get_release_notes', { version });
}

/**
 * Check for updates on startup
 */
export async function startupCheck(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return await invoke('ota_startup_check');
}

/**
 * React hook for update notifications
 */
export function useUpdateNotifications() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (!isTauri()) return; // skip all update machinery in browser mode

    // Listen for update available
    const unlistenUpdate = listen<UpdateInfo>('update-available', (event) => {
      setUpdateInfo(event.payload);
    });

    // Listen for download progress
    const unlistenProgress = listen<number>('update-download-progress', (event) => {
      setDownloadProgress(event.payload);
      setIsDownloading(true);
    });

    // Listen for download complete
    const unlistenComplete = listen('update-download-complete', () => {
      setIsDownloading(false);
      setDownloadProgress(100);
    });

    // Check for updates on mount
    startupCheck().then(setUpdateInfo).catch(console.error);

    return () => {
      unlistenUpdate.then(fn => fn());
      unlistenProgress.then(fn => fn());
      unlistenComplete.then(fn => fn());
    };
  }, []);

  const dismissUpdate = () => setUpdateInfo(null);

  const installUpdate = async () => {
    if (!updateInfo?.update_available) return;
    
    try {
      await downloadAndInstall();
    } catch (error) {
      console.error('Failed to install update:', error);
    }
  };

  return {
    updateInfo,
    downloadProgress,
    isDownloading,
    dismissUpdate,
    installUpdate,
  };
}
