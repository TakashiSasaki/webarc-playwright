// archiveService.js

// ========================
// Configuration Constants
// ========================
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const ARCHIVE_DIR = path.join(__dirname, 'archive');
const FILE_SIZE_LIMIT = 1073741824; // 1GB in bytes
const PARALLEL_LIMIT = 5; // Maximum number of pages to process concurrently

// ========================
// Required Modules
// ========================
import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { chromium } from 'playwright';
import pLimit from 'p-limit';

// ========================
// URL Normalization Function
// ========================
// Removes unnecessary tracking parameters to normalize the content URL
function normalizeUrl(inputUrl) {
  try {
    const urlObj = new URL(inputUrl);
    const paramsToRemove = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'dclid',
      'fbclid',
      'msclkid',
      'yclid'
    ];
    paramsToRemove.forEach(param => urlObj.searchParams.delete(param));
    return urlObj.toString();
  } catch (err) {
    // Return the original input if URL is invalid
    return inputUrl;
  }
}

// ========================
// Setup Express Application
// ========================
const app = express();

// Create archive directory if it doesn't exist
if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR);
}

// Serve static files from the archive directory
app.use('/files', express.static(ARCHIVE_DIR));

// Serve index.html at the root URL for simple UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Set up parallel limit using p-limit
const limit = pLimit(PARALLEL_LIMIT);

// Global browser instance
let browser;

// ========================
// Launch Global Browser Instance
// ========================
async function launchBrowser() {
  browser = await chromium.launch(); // Launch in headless mode by default
  console.log('Global browser instance launched.');
}

// ========================
// Archive Endpoint
// ========================
app.get('/archive', async (req, res) => {
  const originalUrl = req.query.url;
  if (!originalUrl) {
    return res.status(400).json({ error: 'URL is required as a query parameter.' });
  }

  // Normalize URL by removing tracking parameters
  const normalizedUrl = normalizeUrl(originalUrl);
  // Use SHA1 hash of normalized URL as filename stem
  const hash = crypto.createHash('sha1').update(normalizedUrl).digest('hex');
  const archiveSubDir = path.join(ARCHIVE_DIR, hash);
  fs.mkdirSync(archiveSubDir, { recursive: true });
  
  // Base public URL for the saved files
  const baseUrl = `${req.protocol}://${req.get('host')}/files/${hash}`;
  
  try {
    await limit(async () => {
      const page = await browser.newPage();
      // Navigate to the normalized URL
      const response = await page.goto(normalizedUrl, { waitUntil: 'networkidle' });
      
      // Check: if Content-Length exceeds 1GB, abort processing
      const contentLengthHeader = response.headers()['content-length'];
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > FILE_SIZE_LIMIT) {
        throw new Error('File size exceeds 1GB, not saving.');
      }
      
      const contentType = response.headers()['content-type'] || '';
      let savedFiles = {};

      if (contentType.includes('text/html')) {
        // For HTML: save rendered DOM as HTML file
        const htmlContent = await page.content();
        const htmlFileName = `${hash}.html`;
        fs.writeFileSync(path.join(archiveSubDir, htmlFileName), htmlContent, 'utf-8');
        savedFiles.html = `${baseUrl}/${htmlFileName}`;

        // Save as PDF (available in Chromium)
        const pdfFileName = `${hash}.pdf`;
        await page.pdf({ path: path.join(archiveSubDir, pdfFileName), format: 'A4' });
        savedFiles.pdf = `${baseUrl}/${pdfFileName}`;

        // Save full-page screenshot
        const screenshotFileName = `${hash}.png`;
        await page.screenshot({ path: path.join(archiveSubDir, screenshotFileName), fullPage: true });
        savedFiles.screenshot = `${baseUrl}/${screenshotFileName}`;
      } else if (contentType.includes('application/pdf')) {
        // For PDF: directly save binary data
        const buffer = await response.body();
        const pdfFileName = `${hash}.pdf`;
        fs.writeFileSync(path.join(archiveSubDir, pdfFileName), buffer);
        savedFiles.file = `${baseUrl}/${pdfFileName}`;
      } else if (contentType.startsWith('image/')) {
        // For images: determine extension based on content-type
        let ext = 'png';
        if (contentType.includes('jpeg')) ext = 'jpg';
        else if (contentType.includes('gif')) ext = 'gif';
        const buffer = await response.body();
        const imageFileName = `${hash}.${ext}`;
        fs.writeFileSync(path.join(archiveSubDir, imageFileName), buffer);
        savedFiles.file = `${baseUrl}/${imageFileName}`;
      } else if (contentType.startsWith('video/')) {
        // For videos: determine extension from content-type
        const ext = contentType.split('/')[1] || 'mp4';
        const buffer = await response.body();
        const videoFileName = `${hash}.${ext}`;
        fs.writeFileSync(path.join(archiveSubDir, videoFileName), buffer);
        savedFiles.file = `${baseUrl}/${videoFileName}`;
      } else if (contentType.includes('text/csv')) {
        // For CSV files
        const buffer = await response.body();
        const csvFileName = `${hash}.csv`;
        fs.writeFileSync(path.join(archiveSubDir, csvFileName), buffer);
        savedFiles.file = `${baseUrl}/${csvFileName}`;
      } else if (
        contentType.includes('application/vnd.ms-excel') ||
        contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      ) {
        // For Excel files: decide extension based on content-type
        let ext = 'xls';
        if (contentType.includes('openxmlformats-officedocument.spreadsheetml.sheet')) ext = 'xlsx';
        const buffer = await response.body();
        const excelFileName = `${hash}.${ext}`;
        fs.writeFileSync(path.join(archiveSubDir, excelFileName), buffer);
        savedFiles.file = `${baseUrl}/${excelFileName}`;
      } else if (
        contentType.includes('application/msword') ||
        contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      ) {
        // For Word documents: decide extension based on content-type
        let ext = 'doc';
        if (contentType.includes('openxmlformats-officedocument.wordprocessingml.document')) ext = 'docx';
        const buffer = await response.body();
        const wordFileName = `${hash}.${ext}`;
        fs.writeFileSync(path.join(archiveSubDir, wordFileName), buffer);
        savedFiles.file = `${baseUrl}/${wordFileName}`;
      } else if (contentType.includes('application/zip')) {
        // For ZIP files
        const buffer = await response.body();
        const zipFileName = `${hash}.zip`;
        fs.writeFileSync(path.join(archiveSubDir, zipFileName), buffer);
        savedFiles.file = `${baseUrl}/${zipFileName}`;
      } else {
        // Fallback: save as HTML
        const htmlContent = await page.content();
        const htmlFileName = `${hash}.html`;
        fs.writeFileSync(path.join(archiveSubDir, htmlFileName), htmlContent, 'utf-8');
        savedFiles.html = `${baseUrl}/${htmlFileName}`;
      }
      
      await page.close();
    });

    res.json(savedFiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Archiving failed.' });
  }
});

// ========================
// Launch Browser and Start Server
// ========================
launchBrowser()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Archive service listening at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to launch browser:', error);
  });

/*
Commit Message: "Add index.html route for simple UI integration in archiveService.js"
*/
