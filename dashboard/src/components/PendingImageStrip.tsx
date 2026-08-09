import React from 'react';
import type { PendingImage } from '../lib/downscale-image';

export function removePendingImage(images: PendingImage[], index: number): PendingImage[] {
  return images.filter((_, position) => position !== index);
}

export function PendingImageStrip({ images, onChange }: {
  images: PendingImage[];
  onChange(next: PendingImage[]): void;
}) {
  if (images.length === 0) {
    return null;
  }
  return (
    <div className="pending-images" role="list">
      {images.map((image, index) => (
        <div className="pending-image" role="listitem" key={`${index}:${image.dataUrl.slice(0, 32)}`}>
          <img src={image.dataUrl} alt={`Pending attachment ${index + 1}`} />
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
    </div>
  );
}
