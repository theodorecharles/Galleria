import { createContext, useContext, useState, useRef, ReactNode, useEffect, useMemo, useCallback } from 'react';
import { info } from '../utils/logger';

interface SSEToasterContextType {
  // Titles job state
  generatingTitles: boolean;
  setGeneratingTitles: (value: boolean) => void;
  titlesOutput: string[];
  setTitlesOutput: (value: string[] | ((prev: string[]) => string[])) => void;
  titlesProgress: number;
  setTitlesProgress: (value: number) => void;
  titlesWaiting: number | null;
  setTitlesWaiting: (value: number | null) => void;
  titlesOutputRef: React.RefObject<HTMLDivElement | null>;
  titlesAbortController: React.MutableRefObject<AbortController | null>;
  
  // Optimization job state
  isOptimizationRunning: boolean;
  setIsOptimizationRunning: (value: boolean) => void;
  optimizationLogs: string[];
  setOptimizationLogs: (value: string[] | ((prev: string[]) => string[])) => void;
  optimizationProgress: number;
  setOptimizationProgress: (value: number) => void;
  optimizationComplete: boolean;
  setOptimizationComplete: (value: boolean) => void;
  optimizationOutputRef: React.RefObject<HTMLDivElement | null>;
  optimizationAbortController: React.MutableRefObject<AbortController | null>;
  
  // Upload job state
  isUploading: boolean;
  setIsUploading: (value: boolean) => void;
  uploadAlbum: string;
  setUploadAlbum: (value: string) => void;
  uploadCompleted: number;
  setUploadCompleted: (value: number) => void;
  uploadTotal: number;
  setUploadTotal: (value: number) => void;
  
  // Toaster UI state
  isToasterCollapsed: boolean;
  setIsToasterCollapsed: (value: boolean) => void;
  isToasterMaximized: boolean;
  setIsToasterMaximized: (value: boolean) => void;
  toasterPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  setToasterPosition: (value: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left') => void;
  toasterSize: { width: number; height: number };
  setToasterSize: (value: { width: number; height: number }) => void;
  isDragging: boolean;
  setIsDragging: (value: boolean) => void;
  dragStart: { x: number; y: number } | null;
  setDragStart: (value: { x: number; y: number } | null) => void;
  dragOffset: { x: number; y: number };
  setDragOffset: (value: { x: number; y: number }) => void;
  isResizing: boolean;
  setIsResizing: (value: boolean) => void;
  resizeStart: { width: number; height: number; x: number; y: number } | null;
  setResizeStart: (value: { width: number; height: number; x: number; y: number } | null) => void;
  hasToasterAnimated: boolean;
  setHasToasterAnimated: (value: boolean) => void;
  isScrollLocked: boolean;
  setIsScrollLocked: (value: boolean) => void;
  
  // Stop handlers (provided by ConfigManager when mounted)
  stopTitlesHandler: (() => void) | null;
  setStopTitlesHandler: (handler: (() => void) | null) => void;
  stopOptimizationHandler: (() => void) | null;
  setStopOptimizationHandler: (handler: (() => void) | null) => void;
  
  // Title update callback (provided by AlbumsManager when mounted)
  onTitleUpdate: ((album: string, filename: string, title: string) => void) | null;
  setOnTitleUpdate: (handler: ((album: string, filename: string, title: string) => void) | null) => void;
  addTitleUpdate: (album: string, filename: string, title: string) => void;
  getBufferedUpdates: (album: string) => Record<string, string>;
  
  // Helper methods
  resetToasterState: () => void;
}

const SSEToasterContext = createContext<SSEToasterContextType | undefined>(undefined);

export function SSEToasterProvider({ children }: { children: ReactNode }) {
  // Titles job state
  const [generatingTitles, setGeneratingTitles] = useState(false);
  const [titlesOutput, setTitlesOutput] = useState<string[]>([]);
  const [titlesProgress, setTitlesProgress] = useState(0);
  const [titlesWaiting, setTitlesWaiting] = useState<number | null>(null);
  const titlesOutputRef = useRef<HTMLDivElement>(null);
  const titlesAbortController = useRef<AbortController | null>(null);
  
  // Optimization job state
  const [isOptimizationRunning, setIsOptimizationRunning] = useState(false);
  const [optimizationLogs, setOptimizationLogs] = useState<string[]>([]);
  const [optimizationProgress, setOptimizationProgress] = useState(0);
  const [optimizationComplete, setOptimizationComplete] = useState(false);
  const optimizationOutputRef = useRef<HTMLDivElement>(null);
  const optimizationAbortController = useRef<AbortController | null>(null);
  
  // Upload job state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadAlbum, setUploadAlbum] = useState('');
  const [uploadCompleted, setUploadCompleted] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  
  // Toaster UI state
  const [isToasterCollapsed, setIsToasterCollapsed] = useState(false);
  const [isToasterMaximized, setIsToasterMaximized] = useState(false);
  const [toasterPosition, setToasterPosition] = useState<'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'>('bottom-left');
  const [toasterSize, setToasterSize] = useState({ width: 550, height: 400 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isResizing, setIsResizing] = useState(false);
  const [resizeStart, setResizeStart] = useState<{ width: number; height: number; x: number; y: number } | null>(null);
  const [hasToasterAnimated, setHasToasterAnimated] = useState(false);
  const [isScrollLocked, setIsScrollLocked] = useState(true); // Start locked by default
  
  // Stop handlers (set by ConfigManager when mounted)
  const [stopTitlesHandler, setStopTitlesHandler] = useState<(() => void) | null>(null);
  const [stopOptimizationHandler, setStopOptimizationHandler] = useState<(() => void) | null>(null);
  
  // Title update callback (set by AlbumsManager when mounted)
  const [onTitleUpdate, setOnTitleUpdate] = useState<((album: string, filename: string, title: string) => void) | null>(null);
  
  // Buffer for title updates (so they can be applied when album opens)
  // Format: { albumName: { filename: title } }
  const titleUpdatesBuffer = useRef<Record<string, Record<string, string>>>({});
  
  // Function to add title update to buffer and call callback if available
  const addTitleUpdate = useCallback((album: string, filename: string, title: string) => {
    // Add to buffer
    if (!titleUpdatesBuffer.current[album]) {
      titleUpdatesBuffer.current[album] = {};
    }
    titleUpdatesBuffer.current[album][filename] = title;
    
    // Call callback if available
    if (onTitleUpdate) {
      onTitleUpdate(album, filename, title);
    }
  }, [onTitleUpdate]);
  
  // Function to get and clear buffered updates for an album
  const getBufferedUpdates = useCallback((album: string) => {
    const updates = titleUpdatesBuffer.current[album] || {};
    delete titleUpdatesBuffer.current[album];
    return updates;
  }, []);
  
  // Reset toaster to default state
  const resetToasterState = useCallback(() => {
    setToasterPosition('bottom-left');
    setIsToasterCollapsed(false);
    setIsToasterMaximized(false);
    setHasToasterAnimated(false);
    setIsScrollLocked(true); // Re-lock scroll when resetting
  }, []);
  
  // Disable page scrolling when toaster is maximized
  useEffect(() => {
    if (isToasterMaximized) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    return () => {
      document.body.style.overflow = '';
    };
  }, [isToasterMaximized]);
  
  // Mark toaster as animated after initial slide-in completes
  useEffect(() => {
    const isAnyJobRunning = generatingTitles || isOptimizationRunning || isUploading;
    if (isAnyJobRunning && !hasToasterAnimated) {
      const timer = setTimeout(() => {
        setHasToasterAnimated(true);
      }, 300); // Match animation duration
      
      return () => clearTimeout(timer);
    }
  }, [generatingTitles, isOptimizationRunning, isUploading, hasToasterAnimated]);
  
  // Log when provider re-renders (for debugging)
  useEffect(() => {
    info('[SSEToasterProvider] Render');
  });
  
  const value = useMemo(() => ({
    generatingTitles,
    setGeneratingTitles,
    titlesOutput,
    setTitlesOutput,
    titlesProgress,
    setTitlesProgress,
    titlesWaiting,
    setTitlesWaiting,
    titlesOutputRef,
    titlesAbortController,
    isOptimizationRunning,
    setIsOptimizationRunning,
    optimizationLogs,
    setOptimizationLogs,
    optimizationProgress,
    setOptimizationProgress,
    optimizationComplete,
    setOptimizationComplete,
    optimizationOutputRef,
    optimizationAbortController,
    isUploading,
    setIsUploading,
    uploadAlbum,
    setUploadAlbum,
    uploadCompleted,
    setUploadCompleted,
    uploadTotal,
    setUploadTotal,
    isToasterCollapsed,
    setIsToasterCollapsed,
    isToasterMaximized,
    setIsToasterMaximized,
    toasterPosition,
    setToasterPosition,
    toasterSize,
    setToasterSize,
    isDragging,
    setIsDragging,
    dragStart,
    setDragStart,
    dragOffset,
    setDragOffset,
    isResizing,
    setIsResizing,
    resizeStart,
    setResizeStart,
    hasToasterAnimated,
    setHasToasterAnimated,
    isScrollLocked,
    setIsScrollLocked,
    stopTitlesHandler,
    setStopTitlesHandler,
    stopOptimizationHandler,
    setStopOptimizationHandler,
    onTitleUpdate,
    setOnTitleUpdate,
    addTitleUpdate,
    getBufferedUpdates,
    resetToasterState,
  }), [
    generatingTitles,
    titlesOutput,
    titlesProgress,
    titlesWaiting,
    titlesOutputRef,
    titlesAbortController,
    isOptimizationRunning,
    optimizationLogs,
    optimizationProgress,
    optimizationComplete,
    optimizationOutputRef,
    optimizationAbortController,
    isUploading,
    uploadAlbum,
    uploadCompleted,
    uploadTotal,
    isToasterCollapsed,
    isToasterMaximized,
    toasterPosition,
    toasterSize,
    isDragging,
    dragStart,
    dragOffset,
    isResizing,
    resizeStart,
    hasToasterAnimated,
    isScrollLocked,
    stopTitlesHandler,
    stopOptimizationHandler,
    onTitleUpdate,
    addTitleUpdate,
    getBufferedUpdates,
    resetToasterState,
  ]);
  
  return (
    <SSEToasterContext.Provider value={value}>
      {children}
    </SSEToasterContext.Provider>
  );
}

export function useSSEToaster() {
  const context = useContext(SSEToasterContext);
  if (context === undefined) {
    throw new Error('useSSEToaster must be used within a SSEToasterProvider');
  }
  return context;
}

