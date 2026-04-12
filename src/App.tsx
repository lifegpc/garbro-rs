import { App as AntApp } from "antd";
import { getStartDirectory } from "./api";
import { FileExplorer } from "./components/FileExplorer";
import { ImagePreviewPanel } from "./components/ImagePreviewPanel";
import { useEffect, useState } from "react";
import { Entry, FileOptions } from "./types";
import "./App.css";

interface PreviewTarget {
  path: string;
  options?: FileOptions[];
}

function AppContent() {
  const [startDirectory, setStartDirectory] = useState<string>("");
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  useEffect(() => {
    getStartDirectory().then(setStartDirectory);
  }, []);

  const handleEntrySelect = (entry: Entry, fullPath: string, options?: FileOptions[]) => {
    if (entry.entry_type === 'Image') {
      setPreview({ path: fullPath, options });
    } else {
      setPreview(null);
    }
  };

  return (
    <div className="app-layout">
      <div className="app-sidebar">
        {startDirectory && (
          <FileExplorer initialPath={startDirectory} onEntrySelect={handleEntrySelect} />
        )}
      </div>
      <div className="app-content">
        {preview ? (
          <ImagePreviewPanel path={preview.path} options={preview.options} />
        ) : (
          <span style={{ color: "#8c8c8c" }}>选择图片文件以预览</span>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <AntApp>
      <AppContent />
    </AntApp>
  );
}

export default App;
