import { badRequest } from '../errors.js';

const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
export function decodeMedia({ mime, data }) {
  const video = mime?.startsWith('video/'),
    limit = (video ? 16 : 8) * 1024 * 1024;
  if (
    !extensions[mime] ||
    typeof data !== 'string' ||
    data.length > Math.ceil(limit / 3) * 4 + 16 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(data)
  )
    throw badRequest('Изображения: PNG/JPG/WebP/GIF до 8 МБ; видео: MP4/WebM до 16 МБ.');
  const bytes = Buffer.from(data, 'base64');
  let valid = false;
  if (mime === 'image/png')
    valid = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') valid = bytes[0] === 255 && bytes[1] === 216;
  if (mime === 'image/webp')
    valid = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/gif') valid = /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
  if (mime === 'video/mp4')
    valid =
      bytes.length >= 16 &&
      bytes.toString('ascii', 4, 8) === 'ftyp' &&
      bytes.readUInt32BE(0) >= 16 &&
      bytes.readUInt32BE(0) <= bytes.length;
  if (mime === 'video/webm')
    valid =
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      bytes.subarray(0, 4096).includes(Buffer.from('webm'));
  if (!valid || bytes.length > limit)
    throw badRequest('Содержимое файла не соответствует формату или превышает размер.');
  return { bytes, extension: extensions[mime] };
}
