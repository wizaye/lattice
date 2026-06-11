import React from 'react';
import { useUpdateNotifications } from '../../lib/ota-updater';
import './UpdateNotification.css';

export const UpdateNotification: React.FC = () => {
  const { updateInfo, downloadProgress, isDownloading, dismissUpdate, installUpdate } = useUpdateNotifications();

  if (!updateInfo?.update_available) {
    return null;
  }

  return (
    <div className="update-notification">
      <div className="update-notification-content">
        <div className="update-icon">🚀</div>
        <div className="update-details">
          <h3>Update Available</h3>
          <p>
            Version {updateInfo.latest_version} is ready to install
            {updateInfo.published_at && (
              <span className="update-date"> • {new Date(updateInfo.published_at).toLocaleDateString()}</span>
            )}
          </p>
          
          {updateInfo.release_notes && (
            <div className="release-notes">
              <details>
                <summary>Release Notes</summary>
                <div className="release-notes-content">
                  {updateInfo.release_notes}
                </div>
              </details>
            </div>
          )}

          {isDownloading && (
            <div className="download-progress">
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
              <span className="progress-text">{Math.round(downloadProgress)}%</span>
            </div>
          )}
        </div>

        <div className="update-actions">
          {!isDownloading ? (
            <>
              <button className="btn-primary" onClick={installUpdate}>
                Install Update
              </button>
              <button className="btn-secondary" onClick={dismissUpdate}>
                Later
              </button>
            </>
          ) : (
            <button className="btn-secondary" disabled>
              Downloading...
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
