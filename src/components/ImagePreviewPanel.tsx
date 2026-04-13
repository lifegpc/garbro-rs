import React, { useEffect, useRef, useState } from 'react';
import { Spin, Button, Tooltip, Space } from 'antd';
import { CompressOutlined, BorderOuterOutlined } from '@ant-design/icons';
import { FileOptions } from '../types';
import { previewImage } from '../api';
import pica from 'pica';
import { useDebounce } from 'use-debounce';

const picaInstance = pica({ features: ['js', 'wasm', 'cib'] });

interface ImagePreviewPanelProps {
  path: string;
  options?: FileOptions[];
}

type ScaleMode = 'fit' | '100%' | 'fill' | 'custom';

export function ImagePreviewPanel({ path, options }: ImagePreviewPanelProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [imageSize, setImageSize] = useState<{ w: number, h: number } | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number, h: number } | null>(null);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit');
  const [customScale, setCustomScale] = useState<number>(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const prevUrlRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const isDragging = useRef(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, imgX: 0, imgY: 0 });

  // Load image
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setObjectUrl(null);
    setImageSize(null);
    setScaleMode('fit');
    setCustomScale(1);
    setPosition({ x: 0, y: 0 });

    previewImage(path, options)
      .then(bytes => {
        if (cancelled) return;
        const blob = new Blob([bytes as any], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = url;
        setObjectUrl(url);
      })
      .catch(err => {
        if (cancelled) return;
        const msg = (err as { msg?: string })?.msg ?? String(err);
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [path, options]);

  // Cleanup object URL
  useEffect(() => {
    return () => {
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
    };
  }, []);

  // Track container size
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          w: entry.contentRect.width,
          h: entry.contentRect.height
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [objectUrl]);

  // Drag logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      setPosition({
        x: dragStart.current.imgX + (e.clientX - dragStart.current.mouseX),
        y: dragStart.current.imgY + (e.clientY - dragStart.current.mouseY),
      });
    };
    const handleMouseUp = () => {
      isDragging.current = false;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    const target = e.target as HTMLImageElement;
    setImageSize({ w: target.naturalWidth, h: target.naturalHeight });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      imgX: position.x,
      imgY: position.y,
    };
  };

  const getScale = (
    mode = scaleMode, 
    cScale = customScale, 
    iSize = imageSize, 
    cSize = containerSize
  ) => {
    if (!iSize || !cSize) return 1;
    const { w, h } = iSize;
    const { w: cw, h: ch } = cSize;
    if (w === 0 || h === 0 || cw === 0 || ch === 0) return 1;

    const rw = cw / w;
    const rh = ch / h;
    const dpr = window.devicePixelRatio || 1;
    const scale100 = 1 / dpr;

    if (mode === 'fit') return Math.min(scale100, rw, rh); // 只缩小不放大 (基于物理像素的100%)
    if (mode === 'fill') return Math.max(rw, rh); // 可以放大超过100%
    if (mode === '100%') return scale100;
    return cScale;
  };

  const currentScale = getScale();
  const [debouncedScale] = useDebounce(currentScale, 300);

  useEffect(() => {
    if (!imgRef.current || !canvasRef.current || !imageSize || !objectUrl) return;
    const cw = Math.max(1, Math.round(imageSize.w * debouncedScale));
    const ch = Math.max(1, Math.round(imageSize.h * debouncedScale));
    
    // To support retina displays, multiply canvas actual dimensions by devicePixelRatio
    const dpr = window.devicePixelRatio || 1;
    const canvas = canvasRef.current;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }

    picaInstance.resize(imgRef.current, canvas, {
      unsharpAmount: 60,
      unsharpRadius: 0.6,
      unsharpThreshold: 2
    }).catch(console.warn);
  }, [debouncedScale, imageSize, objectUrl]);

  const stateRef = useRef({ imageSize, containerSize, scaleMode, customScale, position });
  stateRef.current = { imageSize, containerSize, scaleMode, customScale, position };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = stateRef.current;
      const scaleStr = getScale(state.scaleMode, state.customScale, state.imageSize, state.containerSize);
      
      const scaleFactor = 1.15;
      const delta = e.deltaY < 0 ? 1 : -1;
      let newScale = scaleStr * (delta > 0 ? scaleFactor : 1 / scaleFactor);
      newScale = Math.max(0.05, Math.min(newScale, 100)); // 缩放范围限制 5% 到 10000%

      const rect = container.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const dx = mouseX - cx;
      const dy = mouseY - cy;

      const scaleRatio = newScale / scaleStr;
      
      setPosition({
        x: dx - (dx - state.position.x) * scaleRatio,
        y: dy - (dy - state.position.y) * scaleRatio,
      });
      setCustomScale(newScale);
      setScaleMode('custom');
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [objectUrl]);

  const resetPositionAndSetMode = (mode: ScaleMode) => {
    setScaleMode(mode);
    setPosition({ x: 0, y: 0 }); // Switch mode resets the drag position to center
  };

  if (loading && !objectUrl) {
    return (
      <div style={centerStyle}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={centerStyle}>
        <span style={{ color: '#ff4d4f', fontSize: 13 }}>{error}</span>
      </div>
    );
  }

  if (!objectUrl) return null;

  const visualScale = currentScale / (debouncedScale || currentScale);
  const baseW = imageSize ? imageSize.w * debouncedScale : 0;
  const baseH = imageSize ? imageSize.h * debouncedScale : 0;

  return (
    <div style={containerStyle} ref={containerRef}>
      {/* Hidden original image for pica source */}
      <img
        ref={imgRef}
        src={objectUrl!}
        alt={path.split('|').pop()?.split(/[/\\]/).pop() ?? ''}
        style={{ display: 'none' }}
        onLoad={handleImageLoad}
      />

      <canvas
        ref={canvasRef}
        style={{
          ...imgStyle,
          width: baseW,
          height: baseH,
          transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px)) scale(${visualScale})`,
          cursor: 'grab',
          imageRendering: 'auto',
          visibility: baseW > 0 ? 'visible' : 'hidden',
        }}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
      />

      {/* Toolbar */}
      <div style={toolbarContainerStyle}>
        <Space size={8} style={{ padding: '6px 12px', background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(8px)', borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
          <Tooltip title="适应窗口 (默认只缩小不放大)">
            <Button
              type={scaleMode === 'fit' ? 'primary' : 'text'}
              icon={<CompressOutlined />}
              onClick={() => resetPositionAndSetMode('fit')}
              size="small"
            />
          </Tooltip>
          <Tooltip title="100% 大小">
            <Button
              type={scaleMode === '100%' ? 'primary' : 'text'}
              icon={<span style={{ fontSize: 12, fontWeight: 'bold' }}>1:1</span>}
              onClick={() => resetPositionAndSetMode('100%')}
              size="small"
            />
          </Tooltip>
          <Tooltip title="填充窗口">
            <Button
              type={scaleMode === 'fill' ? 'primary' : 'text'}
              icon={<BorderOuterOutlined />}
              onClick={() => resetPositionAndSetMode('fill')}
              size="small"
            />
          </Tooltip>
        </Space>
      </div>

      {/* Info Status */}
      <div style={infoContainerStyle}>
        <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.7)', fontWeight: 'bold', fontFamily: 'monospace' }}>
          {Math.round(currentScale * (window.devicePixelRatio || 1) * 100)}%
          {imageSize && ` | ${imageSize.w} x ${imageSize.h}`}
        </span>
      </div>
    </div>
  );
}

const centerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
};

const containerStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  padding: 0,
};

const imgStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transformOrigin: 'center',
  imageRendering: 'pixelated',
  borderRadius: 0,
  boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
  willChange: 'transform',
};

const toolbarContainerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  zIndex: 10,
};

const infoContainerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  right: 16,
  zIndex: 10,
  background: 'rgba(255, 255, 255, 0.85)',
  backdropFilter: 'blur(8px)',
  padding: '4px 8px',
  borderRadius: 4,
  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
};
