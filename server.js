const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { createWorker } = require('tesseract.js');
const { Document, Packer, Paragraph, AlignmentType } = require('docx');
const { spawn } = require('child_process');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.static('public'));

// Error handlers
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// PDF to PNG conversion
async function pdfPageToPng(inputPath, pageNumber, outputPath) {
  return new Promise((resolve, reject) => {
    const pdftoppm = spawn('pdftoppm', [
      '-f', pageNumber.toString(),
      '-l', pageNumber.toString(),
      '-png',
      '-r', '300',
      inputPath,
      outputPath.replace('.png', '')
    ]);

    pdftoppm.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pdftoppm failed with code ${code}`)));
    pdftoppm.on('error', reject);
  });
}async function ocrImage(imagePath) {
  console.log(`Starting OCR for ${imagePath}`);
  const worker = await createWorker({
    // You can keep logger here if you want:
    // logger: m => console.log(m)
  });
  
  try {
    // Pass languages as an array, NOT a string
    await worker.initialize(['eng', 'ara']);
    
    const { data: { text } } = await worker.recognize(imagePath);
    return text;
  } finally {
    await worker.terminate();
  }
}


// Word document creation
function createDocxFromText(text) {
  const doc = new Document();
  const paragraphs = text.split('\n\n')
    .filter(p => p.trim())
    .map(line => new Paragraph({
      text: line.trim(),
      alignment: /[\u0600-\u06FF]/.test(line) ? AlignmentType.RIGHT : AlignmentType.LEFT,
    }));
  
  doc.addSection({ children: paragraphs });
  return doc;
}

// Conversion endpoint
app.post('/convert', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const inputPath = req.file.path;
    const outputBase = path.join('uploads', path.parse(req.file.originalname).name);

    // Verify PDF is valid
    const pdfBytes = fs.readFileSync(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    if (pageCount === 0) {
      throw new Error('PDF contains no pages');
    }

    let fullText = '';
    for (let i = 1; i <= pageCount; i++) {
      const pngPath = `${outputBase}-page${i}.png`;
      try {
        await pdfPageToPng(inputPath, i, pngPath);
        const pageText = await ocrImage(pngPath);
        fullText += pageText + '\n\n';
      } finally {
        if (fs.existsSync(pngPath)) {
          fs.unlinkSync(pngPath);
        }
      }
    }

    const doc = createDocxFromText(fullText);
    const buffer = await Packer.toBuffer(doc);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${path.parse(req.file.originalname).name}.docx"`,
    }).send(buffer);

  } catch (err) {
    console.error('Conversion error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));