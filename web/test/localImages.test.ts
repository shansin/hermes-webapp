/**
 * Both halves of showing an image in the transcript are string handling with
 * no visible failure mode: a path that resolves wrong asks the file API for
 * something that isn't there and renders as "couldn't load", and a ref that
 * isn't recognised is left sitting in the message as a line of raw path. The
 * quoting rules in particular are Hermes' own — mirrored here, so they are
 * pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  formatImageRef,
  imageName,
  localImagePath,
  splitAttachedImages,
} from '../src/lib/localImages';

describe('localImagePath', () => {
  it('unwraps a file:// URL', () => {
    expect(localImagePath('file:///home/u/.hermes/cache/x.png')).toBe(
      '/home/u/.hermes/cache/x.png',
    );
  });

  it('decodes percent-escapes and tolerates a host part', () => {
    expect(localImagePath('file://localhost/tmp/my%20shot.png')).toBe('/tmp/my shot.png');
  });

  it('takes a bare absolute path', () => {
    expect(localImagePath('/var/tmp/a.png')).toBe('/var/tmp/a.png');
  });

  it('leaves web and inline sources alone', () => {
    expect(localImagePath('https://example.com/a.png')).toBeNull();
    expect(localImagePath('data:image/png;base64,AAA')).toBeNull();
    expect(localImagePath(undefined)).toBeNull();
  });

  it('resolves workspace:// and image-looking relative paths against the cwd', () => {
    expect(localImagePath('workspace://docs/a.png', '/srv/app/')).toBe('/srv/app/docs/a.png');
    expect(localImagePath('shots/a.png', '/srv/app')).toBe('/srv/app/shots/a.png');
  });

  it('does not invent a path for a relative source with no cwd', () => {
    expect(localImagePath('shots/a.png')).toBeNull();
    expect(localImagePath('workspace://docs/a.png')).toBeNull();
  });

  it('ignores a relative source that is not an image', () => {
    expect(localImagePath('notes/readme.md', '/srv/app')).toBeNull();
  });
});

describe('splitAttachedImages', () => {
  it('lifts a trailing ref off the caption', () => {
    const { text, images } = splitAttachedImages(
      'what is in this photo?\n@image:/home/u/.hermes/images/upload_1.jpg',
    );
    expect(text).toBe('what is in this photo?');
    expect(images).toEqual(['/home/u/.hermes/images/upload_1.jpg']);
  });

  it('reads a quoted path back whole', () => {
    const { text, images } = splitAttachedImages('look\n@image:`/tmp/my shot (1).png`');
    expect(text).toBe('look');
    expect(images).toEqual(['/tmp/my shot (1).png']);
  });

  it('keeps the words of a line that only happens to carry a ref', () => {
    const { text, images } = splitAttachedImages('see @image:/tmp/a.png here');
    expect(text).toBe('see  here');
    expect(images).toEqual(['/tmp/a.png']);
  });

  it('collects several and drops duplicates', () => {
    const { images } = splitAttachedImages('@image:/a.png\n@image:/b.png\n@image:/a.png');
    expect(images).toEqual(['/a.png', '/b.png']);
  });

  it('leaves a message with no refs untouched', () => {
    const msg = 'an email address like a@image.com is not a ref';
    expect(splitAttachedImages(msg)).toEqual({ text: msg, images: [] });
  });

  it('round-trips what formatImageRef writes', () => {
    for (const path of ['/tmp/a.png', '/tmp/a b.png', "/tmp/it's [1].png"]) {
      expect(splitAttachedImages(`caption\n${formatImageRef(path)}`).images).toEqual([path]);
    }
  });
});

describe('imageName', () => {
  it('is the last segment', () => {
    expect(imageName('/home/u/.hermes/images/upload_1.jpg')).toBe('upload_1.jpg');
    expect(imageName('a.png')).toBe('a.png');
  });
});
