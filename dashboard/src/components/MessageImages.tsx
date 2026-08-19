import React, { useEffect, useRef, useState } from 'react';
import type { ImageMetadata } from '@siftkit/contracts';

import { requestImageCaption } from '../api.js';
import { ImageLightbox } from './ImageLightbox';

type CaptionState =
  | { status: 'pending' }
  | { status: 'ready'; caption: string }
  | { status: 'error'; message: string };

function formatBytes(byteLength: number): string {
  return byteLength >= 1_048_576
    ? `${(byteLength / 1_048_576).toFixed(1)} MB`
    : `${Math.round(byteLength / 1024)} KB`;
}

function formatSummary(meta: ImageMetadata): string {
  const format = meta.mime.replace('image/', '');
  return `${meta.width}×${meta.height} · ${format} · ${formatBytes(meta.byteLength)} · ${meta.tokenEstimate.toLocaleString('en-US')} tok`;
}

function formatRemovedImageNotice(removedImageCount: number): string {
  return removedImageCount === 1 ? '1 image removed' : `${removedImageCount} images removed`;
}

export function MessageImages({ sessionId, messageId, images, imageMeta, removedImageCount, chatBusy, onDeleteImage }: {
  sessionId: string;
  messageId: string;
  images: string[];
  imageMeta: ImageMetadata[];
  removedImageCount: number;
  chatBusy: boolean;
  onDeleteImage(imageIndex: number): Promise<void>;
}) {
  const [captionStates, setCaptionStates] = useState<Record<number, CaptionState>>({});
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (images.length === 0 && removedImageCount === 0) {
    return null;
  }

  async function loadCaption(index: number, persisted: string | null): Promise<void> {
    if (persisted !== null) {
      return;
    }
    let shouldRequest = false;
    setCaptionStates((previous) => {
      if (previous[index]?.status === 'pending' || previous[index]?.status === 'ready') {
        return previous;
      }
      shouldRequest = true;
      return { ...previous, [index]: { status: 'pending' } };
    });
    if (!shouldRequest) return;
    try {
      const response = await requestImageCaption(sessionId, messageId, index);
      if (!mountedRef.current) return;
      setCaptionStates((previous) => ({
        ...previous,
        [index]: { status: 'ready', caption: response.caption },
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setCaptionStates((previous) => ({
        ...previous,
        [index]: { status: 'error', message },
      }));
    }
  }

  return (
    <div className="message-images">
      {images.map((image, index) => {
        const meta = imageMeta[index];
        const captionState = captionStates[index];
        const caption = meta?.caption ?? (captionState?.status === 'ready' ? captionState.caption : null);
        const pendingCaption = captionState?.status === 'pending';
        const captionError = captionState?.status === 'error' ? captionState.message : null;
        return (
          <figure className="message-image" key={`${index}:${image.slice(0, 32)}`}>
            <button
              type="button"
              className="image-zoom"
              aria-label={`Enlarge attachment ${index + 1}`}
              title="Enlarge"
              onClick={() => setZoomedIndex(index)}
            >
              <img
                src={image}
                alt={meta ? `Attachment ${index + 1}, ${meta.width} by ${meta.height}` : `Attachment ${index + 1}`}
              />
            </button>
            <button
              type="button"
              className="msg-icon-button danger message-image-remove"
              aria-label={`Delete image ${index + 1}`}
              title="Delete this image and free its context tokens"
              disabled={chatBusy}
              onClick={() => { void onDeleteImage(index); }}
            >
              &#128465;
            </button>
            {meta ? (
              <details onToggle={(event) => {
                if (event.currentTarget.open) {
                  void loadCaption(index, meta.caption);
                }
              }}>
                <summary>{formatSummary(meta)}</summary>
                <p className="image-caption-note">
                  An independent read of this image by the model at this resolution. It is not a
                  transcript of the original turn and cannot show what the model attended to then.
                </p>
                {caption || pendingCaption ? (
                  <p className="image-caption">{caption ?? 'Reading the image…'}</p>
                ) : null}
                {captionError ? (
                  <p className="image-caption-error" role="alert">Unable to load image caption: {captionError}</p>
                ) : null}
              </details>
            ) : null}
          </figure>
        );
      })}
      {removedImageCount > 0 ? (
        <p className="message-image-removed" title="Deleted attachments no longer occupy context tokens.">
          {formatRemovedImageNotice(removedImageCount)}
        </p>
      ) : null}
      {zoomedIndex !== null && images[zoomedIndex] ? (
        <ImageLightbox
          src={images[zoomedIndex]}
          alt={`Attachment ${zoomedIndex + 1}`}
          onClose={() => setZoomedIndex(null)}
        />
      ) : null}
    </div>
  );
}
