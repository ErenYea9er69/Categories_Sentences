pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allSentences = [];
let categorizedSentences = {};
let categories = [];

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

async function discoverCategories(apiKey, sampleSentences) {
  updateProgress(3, 'Step 1/3: AI is discovering natural categories...');

  const prompt = `Analyze these sentences and identify 15-25 broad thematic categories that would cover all the content.

SENTENCES SAMPLE:
${sampleSentences.slice(0, 100).map((s, i) => `${i + 1}. ${s}`).join('\n')}

CATEGORY NAMING GUIDELINES:
- Use clear, descriptive category names
- Use Title-Case-With-Hyphens format (e.g., "Money-Economy", "Technology-Innovation", "Health-Medicine")
- Categories should be broad enough to group multiple sentences
- Each category should represent a distinct theme or topic
- Use hyphens to connect related concepts (e.g., "Work-Career", "Food-Nutrition")
- Examples of good categories: "Science-Research", "Travel-Tourism", "Entertainment-Media", "Family-Relationships", "Nature-Environment"

CRITICAL INSTRUCTIONS:
- Return ONLY a JSON array of category names
- Use 15-25 categories that best represent the document's themes
- No explanations, no extra text, no markdown formatting
- Do not include triple backticks or json code blocks

Example format: ["Money-Economy", "Technology-Innovation", "Health-Medicine", "Education-Learning"]

JSON array:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 3000);
  
  console.log('Categories Discovery Response:', response);
  
  let cleanedResponse = response
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  
  let jsonStr = cleanedResponse.match(/\[[\s\S]*?\]/);
  if (!jsonStr) {
    throw new Error('Failed to extract categories from AI response');
  }
  
  jsonStr = jsonStr[0]
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/,\s*]/g, ']')
    .replace(/,\s*,/g, ',');
  
  const discoveredCategories = JSON.parse(jsonStr);
  
  // Always add "Uncategorized" as a fallback
  discoveredCategories.push("Uncategorized");
  
  return discoveredCategories;
}

async function categorizeBatch(apiKey, sentences, categories, batchIndex, totalBatches) {
  const percent = 10 + (batchIndex / totalBatches) * 70;
  updateProgress(percent, `Step 2/3: Categorizing batch ${batchIndex + 1}/${totalBatches}...`);

  const prompt = `You must categorize each sentence into ONE category from the list below. Choose the MOST RELEVANT category based on the main topic or theme of the sentence.

AVAILABLE CATEGORIES:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}

SENTENCES TO CATEGORIZE:
${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

CRITICAL INSTRUCTIONS:
- Return ONLY a JSON array with EXACTLY ${sentences.length} category names
- Each category name must be EXACTLY as listed above (matching capitalization and hyphens)
- Choose the single most relevant category for each sentence
- If unsure, use "Uncategorized"
- No explanations, no extra text, no markdown formatting
- Do not include triple backticks or json code blocks in your response

Example format: ["Money-Economy", "Technology-Innovation", "Nature-Environment"]

JSON array:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 4000);
  
  console.log('Raw AI Response:', response);
  
  let cleanedResponse = response
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  
  console.log('Cleaned Response:', cleanedResponse);
  
  let jsonStr = null;
  let jsonMatch = cleanedResponse.match(/\[[^\]]*\]/s);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }
  
  if (!jsonStr) {
    const matches = cleanedResponse.match(/\[[\s\S]*\]/g);
    if (matches && matches.length > 0) {
      jsonStr = matches.reduce((a, b) => a.length > b.length ? a : b);
    }
  }
  
  if (!jsonStr) {
    const afterColon = cleanedResponse.split(/(?:JSON array:|array:|output:|result:)/i).pop();
    if (afterColon) {
      jsonMatch = afterColon.match(/\[[\s\S]*?\]/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }
  }
  
  if (!jsonStr) {
    console.error('Could not find JSON array in response');
    throw new Error('No JSON array found in AI response. Check console for details.');
  }
  
  console.log('Extracted JSON string:', jsonStr);
  
  jsonStr = jsonStr
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/,\s*]/g, ']')
    .replace(/,\s*,/g, ',');
  
  try {
    const result = JSON.parse(jsonStr);
    if (!Array.isArray(result)) {
      throw new Error('Response is not an array');
    }
    if (result.length !== sentences.length) {
      console.warn(`Expected ${sentences.length} categories, got ${result.length}`);
      while (result.length < sentences.length) {
        result.push('Uncategorized');
      }
      if (result.length > sentences.length) {
        result.length = sentences.length;
      }
    }
    return result;
  } catch (e) {
    console.error('Failed to parse JSON:', jsonStr);
    console.error('Original response:', response);
    throw new Error('Failed to parse categorization: ' + e.message);
  }
}

async function verifyAndCorrectCategorization(apiKey, categorizedSentences, categories) {
  updateProgress(85, 'Step 3/3: AI is verifying categorizations...');

  // Get a sample of categorizations to verify (up to 30 sentences from various categories)
  let sampleData = [];
  let sampledCategories = Object.keys(categorizedSentences).slice(0, 10);
  
  for (const category of sampledCategories) {
    const sentences = categorizedSentences[category];
    if (sentences.length > 0) {
      const samplesToTake = Math.min(3, sentences.length);
      for (let i = 0; i < samplesToTake; i++) {
        sampleData.push({
          sentence: sentences[i],
          currentCategory: category
        });
      }
    }
  }

  if (sampleData.length === 0) {
    return categorizedSentences; // Nothing to verify
  }

  const prompt = `Review these sentence categorizations and check if they are correctly placed. For each sentence, either confirm the current category or suggest a better one from the available categories.

AVAILABLE CATEGORIES:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}

SENTENCES TO REVIEW:
${sampleData.map((item, i) => `${i + 1}. [Current: ${item.currentCategory}] "${item.sentence}"`).join('\n\n')}

CRITICAL INSTRUCTIONS:
- Return ONLY a JSON array with EXACTLY ${sampleData.length} category names
- For each sentence, return the BEST category (can be the same as current or a better one)
- Each category must be EXACTLY from the list above
- No explanations, no extra text, no markdown formatting

Example format: ["Money-Economy", "Technology-Innovation", "Nature-Environment"]

JSON array:`;

  const messages = [{ role: 'user', content: prompt }];
  
  try {
    const response = await callLongCatAPI(apiKey, messages, 3000);
    
    let cleanedResponse = response
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    
    let jsonStr = cleanedResponse.match(/\[[\s\S]*?\]/);
    if (!jsonStr) {
      console.warn('Could not parse verification response, skipping verification step');
      return categorizedSentences;
    }
    
    jsonStr = jsonStr[0]
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/,\s*]/g, ']')
      .replace(/,\s*,/g, ',');
    
    const verifiedCategories = JSON.parse(jsonStr);
    
    // Apply corrections
    let correctionsMade = 0;
    for (let i = 0; i < sampleData.length && i < verifiedCategories.length; i++) {
      const item = sampleData[i];
      const newCategory = verifiedCategories[i];
      
      if (newCategory !== item.currentCategory && categories.includes(newCategory)) {
        // Remove from old category
        const oldCatIndex = categorizedSentences[item.currentCategory].indexOf(item.sentence);
        if (oldCatIndex > -1) {
          categorizedSentences[item.currentCategory].splice(oldCatIndex, 1);
        }
        
        // Add to new category
        if (!categorizedSentences[newCategory]) {
          categorizedSentences[newCategory] = [];
        }
        categorizedSentences[newCategory].push(item.sentence);
        correctionsMade++;
      }
    }
    
    console.log(`Verification complete: ${correctionsMade} corrections made`);
    updateProgress(90, `Verification complete: ${correctionsMade} corrections made`);
    
  } catch (error) {
    console.warn('Verification step failed, continuing with original categorization:', error);
  }
  
  return categorizedSentences;
}

function displayResults() {
  updateProgress(100, 'Complete! Displaying results...');
  const container = document.getElementById('categoriesContainer');
  container.innerHTML = '';

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

    const categoryPages = {};

    function addNewPage() {
      doc.addPage();
      yPosition = margin;
      
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

    addNewPage();

    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text('Table of Contents', margin, yPosition);
    yPosition += 12;

    doc.setFontSize(10);
    
    let categoryIndex = 1;
    const sortedCategories = Object.entries(categorizedSentences)
      .filter(function(entry) { return entry[1].length > 0; })
      .sort(function(a, b) { return b[1].length - a[1].length; });
    
    const tocEntries = [];
    
    for (const [category, sentences] of sortedCategories) {
      if (yPosition > pageHeight - 25) {
        addNewPage();
      }
      
      const tocY = yPosition;
      const tocPage = doc.internal.getNumberOfPages();
      
      tocEntries.push({
        category: category,
        tocPage: tocPage,
        tocY: tocY,
        index: categoryIndex
      });
      
      const countText = `(${sentences.length} sentences)`;
      doc.setFont(undefined, 'normal');
      const countWidth = doc.getTextWidth(countText);
      const availableWidth = contentWidth - countWidth - 10;
      
      const wrappedCategory = doc.splitTextToSize(`${categoryIndex}. ${category}`, availableWidth);
      
      doc.text(wrappedCategory, margin + 5, yPosition);
      
      doc.text(countText, pageWidth - margin - 5, yPosition, { align: 'right' });
      
      yPosition += (wrappedCategory.length * 5) + 2;
      categoryIndex++;
    }

    addNewPage();

    categoryIndex = 1;
    for (const [category, sentences] of sortedCategories) {
      categoryPages[category] = doc.internal.getNumberOfPages();
      
      if (yPosition > pageHeight - 50) {
        addNewPage();
        categoryPages[category] = doc.internal.getNumberOfPages();
      }

      doc.setFontSize(14);
      doc.setFont(undefined, 'bold');
      const categoryTitle = `${categoryIndex}. ${category}`;
      
      const wrappedTitle = doc.splitTextToSize(categoryTitle, contentWidth - 30);
      doc.text(wrappedTitle, margin, yPosition);
      
      const titleHeight = wrappedTitle.length * 6;
      
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.text(`${sentences.length} sentences`, pageWidth - margin, yPosition, { align: 'right' });
      
      yPosition += titleHeight + 2;
      
      doc.setDrawColor(0, 0, 0);
      doc.line(margin, yPosition, pageWidth - margin, yPosition);
      yPosition += 8;

      doc.setFontSize(12);
      doc.setFont(undefined, 'bold');
      
      sentences.forEach((sentence, idx) => {
        if (yPosition > pageHeight - 35) {
          addNewPage();
        }

        const sentenceNum = `${idx + 1}.`;
        doc.text(sentenceNum, margin, yPosition);
        
        const textX = margin + 10;
        const wrapped = doc.splitTextToSize(sentence, contentWidth - 10);
        doc.text(wrapped, textX, yPosition);
        
        yPosition += (wrapped.length * 6.5) + 3;
      });
      
      yPosition += 8;
      categoryIndex++;
    }

    tocEntries.forEach(entry => {
      const targetPage = categoryPages[entry.category];
      if (targetPage) {
        doc.setPage(entry.tocPage);
        
        const sentences = categorizedSentences[entry.category];
        const countText = `(${sentences.length} sentences)`;
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        const countWidth = doc.getTextWidth(countText);
        const availableWidth = contentWidth - countWidth - 10;
        
        doc.setTextColor(0, 0, 255);
        
        const linkText = `${entry.index}. ${entry.category}`;
        
        const textWidth = doc.getTextWidth(linkText);
        
        if (textWidth <= availableWidth) {
          doc.textWithLink(linkText, margin + 5, entry.tocY, { 
            pageNumber: targetPage
          });
        } else {
          let truncated = linkText;
          while (doc.getTextWidth(truncated + '...') > availableWidth && truncated.length > 10) {
            truncated = truncated.slice(0, -1);
          }
          truncated += '...';
          
          doc.textWithLink(truncated, margin + 5, entry.tocY, { 
            pageNumber: targetPage
          });
        }
        
        doc.setTextColor(0, 0, 0);
      }
    });

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

    categories = await discoverCategories(apiKey, allSentences);
    document.getElementById('totalCategories').textContent = categories.length;
    updateProgress(8, `Discovered ${categories.length} categories`);

    categorizedSentences = {};
    categories.forEach(cat => categorizedSentences[cat] = []);

    const totalBatches = Math.ceil(allSentences.length / batchSize);

    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, allSentences.length);
      const batch = allSentences.slice(start, end);

      const batchCategories = await categorizeBatch(apiKey, batch, categories, i, totalBatches);
      batch.forEach((sentence, idx) => {
        let category = batchCategories[idx];
        
        if (!category || !categories.includes(category)) {
          console.warn(`Invalid category "${category}" for sentence: ${sentence.substring(0, 50)}...`);
          category = 'Uncategorized';
        }
        
        if (!categorizedSentences[category]) {
          categorizedSentences[category] = [];
        }
        categorizedSentences[category].push(sentence);
      });

      document.getElementById('processedCount').textContent = end;
      await new Promise(res => setTimeout(res, 1000));
    }

    categorizedSentences = await verifyAndCorrectCategorization(apiKey, categorizedSentences, categories);

    displayResults();
  } catch (error) {
    showError(error.message);
    console.error(error);
  } finally {
    document.getElementById('startBtn').disabled = false;
  }
}