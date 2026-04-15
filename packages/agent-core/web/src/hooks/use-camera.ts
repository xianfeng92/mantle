import { useCallback, useEffect, useRef, useState } from "react";

export interface CameraState {
  /** Whether the camera panel is open. */
  isOpen: boolean;
  /** Whether the camera stream is active and ready. */
  isReady: boolean;
  /** The last captured snapshot as a data URI, or null. */
  snapshot: string | null;
  /** Error message if camera access failed. */
  error: string | null;
}

export interface CameraActions {
  /** Open the camera panel and start the stream. */
  open: () => void;
  /** Close the camera panel and stop the stream. */
  close: () => void;
  /** Capture a snapshot from the live video feed. */
  capture: () => void;
  /** Discard the current snapshot (return to live preview). */
  retake: () => void;
  /** Accept the snapshot and close the panel, returning the data URI. */
  accept: () => string | null;
  /** Ref to attach to the <video> element for live preview. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Hook to manage webcam capture for the chat composer.
 * Uses navigator.mediaDevices.getUserMedia for camera access.
 */
export function useCamera(): [CameraState, CameraActions] {
  const [isOpen, setIsOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Start the camera stream
  const startStream = useCallback(async () => {
    try {
      setError(null);
      setIsReady(false);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsReady(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NotAllowedError") || msg.includes("Permission")) {
        setError("摄像头权限被拒绝。请在浏览器设置中允许摄像头访问。");
      } else if (msg.includes("NotFoundError") || msg.includes("DevicesNotFound")) {
        setError("未检测到摄像头设备。");
      } else {
        setError(`摄像头错误: ${msg}`);
      }
    }
  }, []);

  // Stop the camera stream
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsReady(false);
  }, []);

  const open = useCallback(() => {
    setSnapshot(null);
    setError(null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    stopStream();
    setSnapshot(null);
    setError(null);
    setIsOpen(false);
  }, [stopStream]);

  // Start stream when panel opens
  useEffect(() => {
    if (isOpen && !snapshot) {
      startStream();
    }
    return () => {
      // Cleanup on unmount
      if (!isOpen) {
        stopStream();
      }
    };
  }, [isOpen, snapshot, startStream, stopStream]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isReady) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const dataUri = canvas.toDataURL("image/jpeg", 0.85);
    setSnapshot(dataUri);
    // Pause the stream while previewing
    stopStream();
  }, [isReady, stopStream]);

  const retake = useCallback(() => {
    setSnapshot(null);
    // Stream will restart via the useEffect
  }, []);

  const accept = useCallback(() => {
    const result = snapshot;
    setSnapshot(null);
    setIsOpen(false);
    return result;
  }, [snapshot]);

  return [
    { isOpen, isReady, snapshot, error },
    { open, close, capture, retake, accept, videoRef },
  ];
}
