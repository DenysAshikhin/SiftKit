import React, { useState } from 'react';
import { ImageLightbox } from './ImageLightbox';
import type { PendingImage } from '../lib/downscale-image';

export function removePendingImage(images: PendingImage[], index: number): PendingImage[] {
  return images.filter((_, position) => position !== index);
}

export function PendingImageStrip({ images, pendingCount, onChange }: {
  images: PendingImage[];
  pendingCount: number;
  onChange(next: PendingImage[]): void;
}) {
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
  if (images.length === 0 && pendingCount === 0) {
    return null;
  }
  const zoomedImage = zoomedIndex === null ? null : images[zoomedIndex] ?? null;
  return (
    <div className="pending-images" role="list">
      {images.map((image, index) => (
        <div className="pending-image" role="listitem" key={`${index}:${image.dataUrl.slice(0, 32)}`}>
          <button
            type="button"
            className="image-zoom"
            aria-label={`Enlarge pending attachment ${index + 1}`}
            title="Enlarge"
            onClick={() => setZoomedIndex(index)}
          >
            <img src={image.dataUrl} alt={`Pending attachment ${index + 1}`} />
          </button>
          {image.note ? (
            <span className="pending-image-badge" title={image.note}>resized</span>
          ) : null}
          <button
            type="button"
            className="pending-image-remove"
            aria-label={`Remove image ${index + 1}`}
            title={`Remove image ${index + 1}`}
            onClick={() => onChange(removePendingImage(images, index))}
          >
            ×
          </button>
        </div>
      ))}
      {Array.from({ length: pendingCount }, (_, index) => (
        <div className="pending-image loading" role="listitem" aria-label="Reading image" key={`loading:${index}`}>
          <span className="sp" />
        </div>
      ))}
      {zoomedImage && zoomedIndex !== null ? (
        <ImageLightbox
          src={zoomedImage.dataUrl}
          alt={`Pending attachment ${zoomedIndex + 1}`}
          onClose={() => setZoomedIndex(null)}
        />
      ) : null}
    </div>
  );
}
