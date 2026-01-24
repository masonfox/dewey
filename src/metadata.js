import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isAudio } from './utils.js';

const execFileAsync = promisify(execFile);

// Track if ffprobe is available (checked once)
let ffprobeAvailable = null;
let ffprobeWarningShown = false;

/**
 * Check if ffprobe is available on the system
 * @returns {Promise<boolean>}
 */
async function checkFfprobeAvailable() {
  if (ffprobeAvailable !== null) {
    return ffprobeAvailable;
  }
  
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
    return true;
  } catch (error) {
    ffprobeAvailable = false;
    return false;
  }
}

/**
 * Clean metadata value - trim whitespace and handle empty/placeholder values
 * @param {string|undefined} value - Raw metadata value
 * @returns {string|null}
 */
function cleanMetadataValue(value) {
  if (!value) return null;
  
  const cleaned = value.trim();
  if (!cleaned) return null;
  
  // Handle common placeholder values
  const lowerCleaned = cleaned.toLowerCase();
  if (lowerCleaned === 'unknown' || 
      lowerCleaned === 'unknown artist' || 
      lowerCleaned === 'unknown album' ||
      lowerCleaned === 'n/a') {
    return null;
  }
  
  return cleaned;
}

/**
 * Extract metadata from audio file using ffprobe
 * @param {string} filePath - Path to audio file (.mp3 or .m4b)
 * @param {Object} log - Logger instance
 * @returns {Promise<Object|null>} Extracted metadata or null
 */
export async function extractAudioMetadata(filePath, log) {
  // Check if ffprobe is available
  if (!(await checkFfprobeAvailable())) {
    if (!ffprobeWarningShown) {
      log.warn('⚠️  ffprobe not available or failed, metadata extraction disabled. Install ffmpeg for enhanced accuracy.');
      ffprobeWarningShown = true;
    }
    return null;
  }
  
  try {
    // Run ffprobe to extract format tags
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format_tags=title,artist,album_artist,date,genre',
      '-of', 'json',
      filePath
    ], {
      timeout: 10000, // 10 second timeout
      maxBuffer: 1024 * 1024 // 1MB buffer for output
    });
    
    // Parse JSON output
    const result = JSON.parse(stdout);
    const tags = result?.format?.tags || {};
    
    // Extract and clean fields
    const title = cleanMetadataValue(tags.title);
    const artist = cleanMetadataValue(tags.artist);
    const albumArtist = cleanMetadataValue(tags.album_artist);
    const year = cleanMetadataValue(tags.date);
    const genre = cleanMetadataValue(tags.genre);
    
    // Prefer artist over album_artist, fallback to album_artist if artist is missing
    const author = artist || albumArtist;
    
    // Check if we have any useful metadata
    const hasMetadata = !!(title || author || year || genre);
    
    if (!hasMetadata) {
      log.debug(`🔍 No embedded metadata found in ${path.basename(filePath)}`);
      return null;
    }
    
    const metadata = {
      title,
      author,
      year,
      genre,
      hasMetadata: true,
      source: 'file'
    };
    
    log.debug(`📊 Extracted metadata from ${path.basename(filePath)}:`, metadata);
    
    return metadata;
    
  } catch (error) {
    // ffprobe errors are non-fatal - just log and continue without metadata
    if (error.code === 'ENOENT') {
      if (!ffprobeWarningShown) {
        log.warn('⚠️  ffprobe command not found. Install ffmpeg for enhanced metadata extraction.');
        ffprobeWarningShown = true;
      }
    } else {
      log.debug(`⚠️  Failed to extract metadata from ${path.basename(filePath)}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Extract metadata from directory by selecting best audio file
 * Prefers .m4b files over .mp3 files (M4B typically has better metadata)
 * @param {string} dirPath - Path to directory containing audio files
 * @param {Object} log - Logger instance
 * @returns {Promise<Object|null>} Extracted metadata or null
 */
export async function extractDirectoryMetadata(dirPath, log) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    // Collect audio files, separating by type
    const m4bFiles = [];
    const mp3Files = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      
      const filePath = path.join(dirPath, entry.name);
      if (!isAudio(filePath)) continue;
      
      if (/\.m4b$/i.test(entry.name)) {
        m4bFiles.push(filePath);
      } else if (/\.mp3$/i.test(entry.name)) {
        mp3Files.push(filePath);
      }
    }
    
    // Prefer .m4b files (better metadata), then .mp3 files
    const audioFiles = [...m4bFiles.sort(), ...mp3Files.sort()];
    
    if (audioFiles.length === 0) {
      log.debug(`🔍 No audio files found in ${path.basename(dirPath)}`);
      return null;
    }
    
    // Use the first file (preferring .m4b if available)
    const selectedFile = audioFiles[0];
    const fileType = /\.m4b$/i.test(selectedFile) ? 'M4B' : 'MP3';
    
    log.debug(`📁 Extracting metadata from directory using ${fileType} file: ${path.basename(selectedFile)}`);
    
    // Extract metadata from the selected file
    return await extractAudioMetadata(selectedFile, log);
    
  } catch (error) {
    log.debug(`⚠️  Failed to extract directory metadata from ${path.basename(dirPath)}: ${error.message}`);
    return null;
  }
}
