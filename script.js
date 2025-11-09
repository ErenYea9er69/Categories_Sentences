pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allSentences = [];
let categorizedSentences = {};
let categories = [];

// Predefined categories
const PREDEFINED_CATEGORIES = [
  "Money-Economy",
  "Food",
  "Drinks",
  "Nature",
  "Crime-Law",
  "War",
  "Technologies",
  "Family Activity",
  "Government",
  "Relationships-Communication",
  "Fashion-Appearance",
  "Entertainments",
  "Science",
  "Animals",
  "Places",
  "Feelings",
  "School",
  "Diseases-Medicine",
  "Work-Job",
  "Travel-Transportation"
];

async function extractTextFromPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + ' ';
  }

  return fullText;
}

function splitIntoSentences(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  return sentences.map(s => s.trim()).filter(s => s.length > 10);
}

async function callLongCatAPI(apiKey, messages, maxTokens = 2000) {
  const response = await fetch('https://api.longcat.chat/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'LongCat-Flash-Chat',
      messages: messages,
      max_tokens: maxTokens,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function updateProgress(percent, status) {
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressFill').textContent = Math.round(percent) + '%';
  document.getElementById('statusText').textContent = status;
}

function showError(message) {
  const statusDiv = document.getElementById('statusText');
  statusDiv.className = 'status error';
  statusDiv.textContent = '❌ Error: ' + message;
}

async function categorizeBatch(apiKey, sentences, categories, batchIndex, totalBatches) {
  const percent = 10 + (batchIndex / totalBatches) * 85;
  updateProgress(percent, `Step 2/2: Categorizing batch ${batchIndex + 1}/${totalBatches}...`);

  const prompt = `You must categorize each sentence into ONE category from the list below. Choose the MOST RELEVANT category based on the main topic or theme of the sentence.

AVAILABLE CATEGORIES:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}

SENTENCES TO CATEGORIZE:
${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

CRITICAL INSTRUCTIONS:
- Return ONLY a JSON array with EXACTLY ${sentences.length} category names
- Each category name must be EXACTLY as listed above (matching capitalization and hyphens)
- Choose the single most relevant category for each sentence
- No explanations, no extra text, no markdown formatting
- Do not include triple backticks or json code blocks in your response

Example format: ["Money-Economy", "Food", "Nature"]

JSON array:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 4000);
  
  // Try multiple methods to extract JSON
  let jsonStr = null;
  
  // Method 1: Look for array between brackets
  let jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  } else {
    // Method 2: Try to find it after "JSON array:" or similar
    const afterColon = response.split(/(?:JSON array:|array:|output:)/i).pop();
    if (afterColon) {
      jsonMatch = afterColon.match(/\[[\s\S]*?\]/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }
  }
  
  if (!jsonStr) {
    console.error('AI Response:', response);
    throw new Error('No JSON array found in AI response. Check console for details.');
  }
  
  // Clean up JSON string
  jsonStr = jsonStr.replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Remove control characters
  jsonStr = jsonStr.replace(/\n/g, ' '); // Remove newlines
  jsonStr = jsonStr.replace(/,\s*]/g, ']'); // Remove trailing commas
  
  try {
    const result = JSON.parse(jsonStr);
    if (!Array.isArray(result)) {
      throw new Error('Response is not an array');
    }
    if (result.length !== sentences.length) {
      console.warn(`Expected ${sentences.length} categories, got ${result.length}`);
    }
    return result;
  } catch (e) {
    console.error('Failed to parse JSON:', jsonStr);
    console.error('Original response:', response);
    throw new Error('Failed to parse categorization: ' + e.message);
  }
}

function displayResults() {
  updateProgress(100, 'Complete! Displaying results...');
  const container = document.getElementById('categoriesContainer');
  container.innerHTML = '';

  // Sort categories by number of sentences (descending)
  const sortedCategories = Object.entries(categorizedSentences)
    .filter(function(entry) { return entry[1].length > 0; })
    .sort(function(a, b) { return b[1].length - a[1].length; });

  for (const [category, sentences] of sortedCategories) {
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'category';

    const title = document.createElement('h3');
    title.textContent = `${category} (${sentences.length} sentences)`;
    categoryDiv.appendChild(title);

    sentences.forEach(sentence => {
      const sentenceDiv = document.createElement('div');
      sentenceDiv.className = 'sentence';
      sentenceDiv.textContent = sentence;
      categoryDiv.appendChild(sentenceDiv);
    });

    container.appendChild(categoryDiv);
  }

  document.getElementById('resultsSection').style.display = 'block';
}

function downloadResults() {
  const dataStr = JSON.stringify(categorizedSentences, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'categorized_sentences.json';
  link.click();
  URL.revokeObjectURL(url);
}

function downloadAsPDF() {
  try {
    const { jsPDF } = window.jspdf;
    
    if (!jsPDF) {
      alert('PDF library not loaded. Please refresh the page and try again.');
      return;
    }
    
    const doc = new jsPDF();
    
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    let yPosition = margin;

    // Store page numbers where each category starts for links
    const categoryPages = {};

    // Helper function to add a new page
    function addNewPage() {
      doc.addPage();
      yPosition = margin;
      
      // Add page number footer
      doc.setFontSize(9);
      doc.setTextColor(128, 128, 128);
      doc.text(
        `${doc.internal.getNumberOfPages()}`,
        pageWidth / 2,
        pageHeight - 10,
        { align: 'center' }
      );
      doc.setTextColor(0, 0, 0);
    }

    // ============ TITLE PAGE ============
    doc.setFontSize(32);
    doc.setFont(undefined, 'bold');
    doc.text('Categorized Sentences', pageWidth / 2, 80, { align: 'center' });
    
    doc.setFontSize(12);
    doc.setFont(undefined, 'normal');
    const today = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    doc.text(`Generated on ${today}`, pageWidth / 2, 95, { align: 'center' });

    // Start TOC on new page
    addNewPage();

    // ============ TABLE OF CONTENTS ============
    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text('Table of Contents', margin, yPosition);
    yPosition += 12;

    doc.setFontSize(10);
    
    let categoryIndex = 1;
    const sortedCategories = Object.entries(categorizedSentences)
      .filter(function(entry) { return entry[1].length > 0; })
      .sort(function(a, b) { return b[1].length - a[1].length; });
    
    // Store TOC entries
    const tocEntries = [];
    
    for (const [category, sentences] of sortedCategories) {
      if (yPosition > pageHeight - 25) {
        addNewPage();
      }
      
      // Store the position for later linking
      const tocY = yPosition;
      const tocPage = doc.internal.getNumberOfPages();
      
      tocEntries.push({
        category: category,
        tocPage: tocPage,
        tocY: tocY,
        index: categoryIndex
      });
      
      // Calculate available width for category name
      const countText = `(${sentences.length} sentences)`;
      doc.setFont(undefined, 'normal');
      const countWidth = doc.getTextWidth(countText);
      const availableWidth = contentWidth - countWidth - 10;
      
      // Wrap category text if needed
      const wrappedCategory = doc.splitTextToSize(`${categoryIndex}. ${category}`, availableWidth);
      
      // Add the category name
      doc.text(wrappedCategory, margin + 5, yPosition);
      
      // Add sentence count aligned to the right on the first line
      doc.text(countText, pageWidth - margin - 5, yPosition, { align: 'right' });
      
      yPosition += (wrappedCategory.length * 5) + 2;
      categoryIndex++;
    }

    // ============ CATEGORY CONTENT PAGES ============
    addNewPage();

    categoryIndex = 1;
    for (const [category, sentences] of sortedCategories) {
      // Store the page where this category starts
      categoryPages[category] = doc.internal.getNumberOfPages();
      
      // Check if we need a new page for category header
      if (yPosition > pageHeight - 50) {
        addNewPage();
        categoryPages[category] = doc.internal.getNumberOfPages();
      }

      // Category Header (Bold)
      doc.setFontSize(14);
      doc.setFont(undefined, 'bold');
      const categoryTitle = `${categoryIndex}. ${category}`;
      
      // Wrap the title if it's too long
      const wrappedTitle = doc.splitTextToSize(categoryTitle, contentWidth - 30);
      doc.text(wrappedTitle, margin, yPosition);
      
      const titleHeight = wrappedTitle.length * 6;
      
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.text(`${sentences.length} sentences`, pageWidth - margin, yPosition, { align: 'right' });
      
      yPosition += titleHeight + 2;
      
      // Draw a line under the category
      doc.setDrawColor(0, 0, 0);
      doc.line(margin, yPosition, pageWidth - margin, yPosition);
      yPosition += 8;

      // Sentences
      doc.setFontSize(12);
      doc.setFont(undefined, 'bold');
      
      sentences.forEach((sentence, idx) => {
        // Check if we need a new page
        if (yPosition > pageHeight - 35) {
          addNewPage();
        }

        // Sentence number
        const sentenceNum = `${idx + 1}.`;
        doc.text(sentenceNum, margin, yPosition);
        
        // Sentence text with proper wrapping
        const textX = margin + 10;
        const wrapped = doc.splitTextToSize(sentence, contentWidth - 10);
        doc.text(wrapped, textX, yPosition);
        
        yPosition += (wrapped.length * 6.5) + 3;
      });
      
      yPosition += 8; // Space after category
      categoryIndex++;
    }

    // ============ UPDATE TABLE OF CONTENTS LINKS ============
    tocEntries.forEach(entry => {
      const targetPage = categoryPages[entry.category];
      if (targetPage) {
        doc.setPage(entry.tocPage);
        
        // Calculate available width for category name
        const sentences = categorizedSentences[entry.category];
        const countText = `(${sentences.length} sentences)`;
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        const countWidth = doc.getTextWidth(countText);
        const availableWidth = contentWidth - countWidth - 10;
        
        // Create the clickable link - use the original string, not the wrapped array
        doc.setTextColor(0, 0, 255); // Blue color for links
        
        const linkText = `${entry.index}. ${entry.category}`;
        
        // Check if text needs wrapping
        const textWidth = doc.getTextWidth(linkText);
        
        if (textWidth <= availableWidth) {
          // Text fits on one line - use textWithLink directly
          doc.textWithLink(linkText, margin + 5, entry.tocY, { 
            pageNumber: targetPage
          });
        } else {
          // Text is too long - truncate or use multiple lines without links
          // Option 1: Truncate with ellipsis
          let truncated = linkText;
          while (doc.getTextWidth(truncated + '...') > availableWidth && truncated.length > 10) {
            truncated = truncated.slice(0, -1);
          }
          truncated += '...';
          
          doc.textWithLink(truncated, margin + 5, entry.tocY, { 
            pageNumber: targetPage
          });
        }
        
        doc.setTextColor(0, 0, 0); // Reset to black
      }
    });

    // Go back to last page to ensure proper page count
    doc.setPage(doc.internal.getNumberOfPages());

    doc.save('categorized_sentences.pdf');
    
  } catch (error) {
    console.error('PDF Generation Error:', error);
    alert('Error generating PDF: ' + error.message);
  }
}

async function startProcessing() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const batchSize = parseInt(document.getElementById('batchSize').value);
  const fileInput = document.getElementById('pdfFile');

  if (!apiKey) return alert('Please enter your LongCat API key');
  if (!fileInput.files[0]) return alert('Please select a PDF file');

  document.getElementById('startBtn').disabled = true;
  document.getElementById('progressSection').style.display = 'block';
  document.getElementById('resultsSection').style.display = 'none';

  try {
    updateProgress(0, 'Extracting text from PDF...');
    const text = await extractTextFromPDF(fileInput.files[0]);
    allSentences = splitIntoSentences(text);
    document.getElementById('totalSentences').textContent = allSentences.length;

    if (allSentences.length === 0) throw new Error('No sentences found in PDF');

    // Use predefined categories
    categories = PREDEFINED_CATEGORIES;
    document.getElementById('totalCategories').textContent = categories.length;
    updateProgress(5, `Using ${categories.length} predefined categories`);

    // Initialize categorized sentences object
    categorizedSentences = {};
    categories.forEach(cat => categorizedSentences[cat] = []);

    const totalBatches = Math.ceil(allSentences.length / batchSize);

    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, allSentences.length);
      const batch = allSentences.slice(start, end);

      const batchCategories = await categorizeBatch(apiKey, batch, categories, i, totalBatches);
      batch.forEach((sentence, idx) => {
        const category = batchCategories[idx] || 'Uncategorized';
        if (!categorizedSentences[category]) categorizedSentences[category] = [];
        categorizedSentences[category].push(sentence);
      });

      document.getElementById('processedCount').textContent = end;
      await new Promise(res => setTimeout(res, 1000));
    }

    displayResults();
  } catch (error) {
    showError(error.message);
    console.error(error);
  } finally {
    document.getElementById('startBtn').disabled = false;
  }
}