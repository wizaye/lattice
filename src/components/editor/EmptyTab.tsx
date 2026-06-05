import "./EmptyTab.css";

type Props = {
  onCreate: () => void;
  onGoToFile: () => void;
  onClose: () => void;
};

export function EmptyTab({ onCreate, onGoToFile, onClose }: Props) {
  return (
    <div className="empty-tab">
      <ul className="empty-actions">
        <li>
          <button onClick={onCreate}>Create new note (Ctrl + N)</button>
        </li>
        <li>
          <button onClick={onGoToFile}>Go to file (Ctrl + O)</button>
        </li>
        <li>
          <button onClick={onClose}>Close</button>
        </li>
      </ul>
    </div>
  );
}
