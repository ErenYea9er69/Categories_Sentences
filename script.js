pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allSentences = [];
let categorizedSentences = {};
let categories = [];
let categoryDefinitions = {};
let sentenceConfidence = [];
let sentenceSimilarityMap = {};

function addLog(message, type = 'info') {
  const logDiv = document.getElementById('detailedLog');
  const entry = document.createElement('div');
  entry.className = 'log-entry log-' + type;
  entry.textContent = new Date().toLocaleTimeString() + ' - ' + message;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

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
  // Improved sentence splitting
  text = text.replace(/\s+/g, ' ').trim();
  
  // Handle common abbreviations to avoid false splits
  text = text.replace(/(Mr|Mrs|Dr|Ms|Prof|Sr|Jr|vs|e\.g|i\.e|etc|Inc|Ltd|Co)\./gi, '$1{ABBR}');
  
  // Split on sentence boundaries
  let sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  
  // Restore abbreviations
  sentences = sentences.map(s => s.replace(/{ABBR}/g, '.'));
  
  // Clean and filter
  return sentences
    .map(s => s.trim())
    .filter(s => {
      const wordCount = s.split(/\s+/).length;
      return s.length > 20 && wordCount >= 4 && wordCount <= 50;
    });
}

async function callLongCatAPI(apiKey, messages, maxTokens = 3000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
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
          temperature: 0.1
        })
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      if (attempt === retries) throw error;
      addLog(`API call failed (attempt ${attempt}/${retries}), retrying...`, 'warning');
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
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
  addLog(message, 'error');
}

async function discoverCategories(apiKey, sampleSentences, sampleSize) {
  updateProgress(3, 'Phase 1: AI analyzing document structure...');
  addLog('Starting category discovery with ' + Math.min(sampleSize, sampleSentences.length) + ' sample sentences');

  const prompt = `You are an expert categorization system. Analyze these sentences and create 20-30 broad thematic categories that will PERFECTLY organize ALL content.

SAMPLE SENTENCES (${Math.min(sampleSize, sampleSentences.length)} total):
${sampleSentences.slice(0, sampleSize).map((s, i) => `${i + 1}. ${s}`).join('\n')}

CATEGORY CREATION RULES:
1. Categories must be BROAD but PRECISE (e.g., "Emotions-Psychology", "Nature-Environment")
2. Use Title-Case-With-Hyphens format consistently
3. Each category should cover 15-150+ sentences typically
4. CRITICAL: Cover ALL topics present - military, politics, nature, emotions, work, education, technology, law, etc.
5. Include "Uncategorized" as explicit fallback
6. Think holistically - what are the MAIN themes of this document?

OUTPUT FORMAT:
Return ONLY a valid JSON array of category names. No explanations, no markdown.

JSON ARRAY:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 2500);
  
  addLog('Raw category discovery response received');
  
  let cleanedResponse = response
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/^[^[]*/, '')
    .replace(/[^\]]*$/, '')
    .trim();
  
  const jsonMatch = cleanedResponse.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Could not extract category array from AI response');
  }
  
  let jsonStr = jsonMatch[0]
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/,\s*]/g, ']')
    .replace(/,\s*,/g, ',');
  
  const discoveredCategories = JSON.parse(jsonStr);
  
  if (!discoveredCategories.includes("Uncategorized")) {
    discoveredCategories.push("Uncategorized");
  }
  
  // Deduplicate and clean
  const uniqueCategories = [...new Set(discoveredCategories.map(cat => cat.trim()))];
  
  addLog('Discovered ' + uniqueCategories.length + ' categories: ' + uniqueCategories.slice(0, 8).join(', ') + '...', 'success');
  
  return uniqueCategories;
}

async function createCategoryDefinitions(apiKey, categories, sampleSentences) {
  updateProgress(8, 'Phase 2: Creating detailed category definitions...');
  addLog('Generating precise definitions for each category');

  const prompt = `For each category below, provide a CLEAR, SPECIFIC definition that will guide accurate sentence categorization.

CATEGORIES TO DEFINE:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}

SAMPLE SENTENCES FOR CONTEXT (first 100):
${sampleSentences.slice(0, 100).map((s, i) => `${i + 1}. ${s}`).join('\n')}

DEFINITION REQUIREMENTS:
For each category, write 3-4 sentences explaining:
- Primary topics covered
- Secondary topics included
- Key indicator words/phrases
- What EXCLUDES it from other categories
- Real examples

OUTPUT FORMAT:
Return ONLY a JSON object mapping category names to definitions.

JSON OBJECT:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 3500);
  
  let cleanedResponse = response
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  
  const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    addLog('Could not extract definitions, using minimal definitions', 'warning');
    return {};
  }
  
  const definitions = JSON.parse(jsonMatch[0]);
  addLog('Created definitions for ' + Object.keys(definitions).length + ' categories', 'success');
  
  return definitions;
}

function calculateSimilarity(sentence1, sentence2) {
  const words1 = sentence1.toLowerCase().split(/\s+/);
  const words2 = sentence2.toLowerCase().split(/\s+/);
  const intersection = words1.filter(w => words2.includes(w)).length;
  const union = new Set([...words1, ...words2]).size;
  return intersection / union;
}

function buildSimilarityMap(sentences) {
  addLog('Building similarity map for consistency checks...');
  const map = {};
  
  for (let i = 0; i < sentences.length; i++) {
    map[i] = [];
    for (let j = 0; j < sentences.length; j++) {
      if (i !== j) {
        const sim = calculateSimilarity(sentences[i], sentences[j]);
        if (sim > 0.4) {
          map[i].push({ index: j, similarity: sim });
        }
      }
    }
    map[i].sort((a, b) => b.similarity - a.similarity);
    map[i] = map[i].slice(0, 5); // Top 5 similar sentences
  }
  
  addLog('Similarity map built for ' + sentences.length + ' sentences');
  return map;
}

async function categorizeBatch(apiKey, sentences, categories, categoryDefinitions, batchIndex, totalBatches, passNumber) {
  const percent = 10 + ((batchIndex / totalBatches) * 60 / passNumber);
  updateProgress(percent, `Pass ${passNumber}: Categorizing batch ${batchIndex + 1}/${totalBatches}...`);
  addLog(`Processing batch ${batchIndex + 1}/${totalBatches} (${sentences.length} sentences)`);

  const definitionsText = Object.entries(categoryDefinitions).length > 0
    ? '\n\nCATEGORY DEFINITIONS:\n' + Object.entries(categoryDefinitions).map(([cat, def]) => `${cat}: ${def}`).join('\n\n')
    : '';

  const prompt = `You are a PRECISE categorization system. Assign EXACTLY ONE category to each sentence.

AVAILABLE CATEGORIES:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}${definitionsText}

CATEGORIZATION RULES - READ CAREFULLY:
1. PRIMARY TOPIC ONLY: Choose the category that BEST matches the MAIN subject
2. CONTEXT MATTERS: "The soldier was angry" = Emotions-Psychology, "The soldier retreated" = Conflict-War
3. BE CONSISTENT: Sentences with similar words MUST get same category
4. WHEN IN DOUBT: Use "Uncategorized" - better to be unsure than wrong
5. NO GUESSING: If it doesn't clearly fit, don't force it

SENTENCES TO CATEGORIZE:
${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

OUTPUT REQUIREMENTS:
- Return EXACTLY ${sentences.length} category names in JSON array
- Each must match category list EXACTLY (case-sensitive)
- NO markdown, NO explanations
- Example: ["Work-Career", "Health-Medicine", "Uncategorized"]

JSON ARRAY:`;

  const messages = [{ role: 'user', content: prompt }];
  let response = await callLongCatAPI(apiKey, messages, 5000);
  
  let cleanedResponse = response
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/^[^[]*/, '')
    .replace(/[^\]]*$/, '')
    .trim();
  
  const jsonMatch = cleanedResponse.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    addLog('Failed to parse batch ' + (batchIndex + 1) + ', retrying...', 'warning');
    await new Promise(r => setTimeout(r, 3000));
    return categorizeBatch(apiKey, sentences, categories, categoryDefinitions, batchIndex, totalBatches, passNumber);
  }
  
  let jsonStr = jsonMatch[0]
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/,\s*]/g, ']')
    .replace(/,\s*,/g, ',');
  
  let result = JSON.parse(jsonStr);
  
  if (result.length !== sentences.length) {
    addLog(`Length mismatch: Expected ${sentences.length}, got ${result.length}. Adjusting...`, 'warning');
    while (result.length < sentences.length) {
      result.push('Uncategorized');
    }
    if (result.length > sentences.length) {
      result = result.slice(0, sentences.length);
    }
  }
  
  // Validate categories
  result = result.map(cat => categories.includes(cat) ? cat : 'Uncategorized');
  const invalidCount = result.filter(cat => !categories.includes(cat)).length;
  if (invalidCount > 0) {
    addLog(`Fixed ${invalidCount} invalid categories in batch ${batchIndex + 1}`, 'warning');
  }
  
  return result;
}

async function validateAndRefineBatch(apiKey, sentences, currentCategories, categories, categoryDefinitions, batchIndex, totalBatches, passNumber) {
  const percent = 70 + ((batchIndex / totalBatches) * 20 / passNumber);
  updateProgress(percent, `Pass ${passNumber}: Validating batch ${batchIndex + 1}/${totalBatches}...`);
  addLog(`Validation pass for batch ${batchIndex + 1}/${totalBatches}`);

  const sentenceData = sentences.map((s, i) => ({
    sentence: s,
    currentCategory: currentCategories[i]
  }));

  const definitionsText = Object.entries(categoryDefinitions).length > 0
    ? '\n\nCATEGORY DEFINITIONS:\n' + Object.entries(categoryDefinitions).map(([cat, def]) => `${cat}: ${def}`).join('\n\n')
    : '';

  const prompt = `REVIEW these categorizations. Fix ONLY clear errors.

AVAILABLE CATEGORIES:
${categories.map((cat, i) => `${i + 1}. ${cat}`).join('\n')}${definitionsText}

SENTENCES TO REVIEW (Current Category → Sentence):
${sentenceData.map((item, i) => `${i + 1}. [${item.currentCategory}] → "${item.sentence}"`).join('\n\n')}

VALIDATION RULES:
1. CONFIRM if category is accurate
2. CHANGE ONLY if clearly wrong (e.g., "The soldier fought" in "Food-Nutrition")
3. Check for CONSISTENCY with similar sentences
4. "Uncategorized" is VALID if truly ambiguous

OUTPUT:
- Return EXACTLY ${sentences.length} category names in JSON array
- Can be same as current or improved
- NO explanations, NO markdown

JSON ARRAY:`;

  const messages = [{ role: 'user', content: prompt }];
  const response = await callLongCatAPI(apiKey, messages, 5000);
  
  let cleanedResponse = response
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/^[^[]*/, '')
    .replace(/[^\]]*$/, '')
    .trim();
  
  const jsonMatch = cleanedResponse.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    addLog('Validation failed for batch ' + (batchIndex + 1) + ', keeping original', 'warning');
    return currentCategories;
  }
  
  let jsonStr = jsonMatch[0]
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/,\s*]/g, ']')
    .replace(/,\s*,/g, ',');
  
  let result = JSON.parse(jsonStr);
  
  if (result.length !== sentences.length) {
    addLog(`Validation length mismatch for batch ${batchIndex + 1}, keeping original`, 'warning');
    return currentCategories;
  }
  
  result = result.map(cat => categories.includes(cat) ? cat : 'Uncategorized');
  
  const changes = result.filter((cat, i) => cat !== currentCategories[i]).length;
  if (changes > 0) {
    addLog(`Validation improved ${changes} categorizations in batch ${batchIndex + 1}`, 'success');
  }
  
  return result;
}

async function consistencyCheckPass(apiKey, sentences, categories, categoryDefinitions, currentCategories) {
  updateProgress(90, 'Phase 3: Running consistency checks...');
  addLog('Starting consistency analysis across all batches');
  
  const inconsistencies = [];
  
  // Check similar sentences
  for (let i = 0; i < sentences.length; i++) {
    const similar = sentenceSimilarityMap[i] || [];
    const myCategory = currentCategories[i];
    
    for (const sim of similar) {
      if (currentCategories[sim.index] && currentCategories[sim.index] !== myCategory) {
        inconsistencies.push({
          sentenceIndex: i,
          similarIndex: sim.index,
          sentence: sentences[i],
          similar: sentences[sim.index],
          category1: myCategory,
          category2: currentCategories[sim.index],
          similarity: sim.similarity
        });
      }
    }
  }
  
  if (inconsistencies.length === 0) {
    addLog('No major inconsistencies found', 'success');
    return currentCategories;
  }
  
  addLog(`Found ${inconsistencies.length} potential inconsistencies`, 'warning');
  
  // Fix top 10% most severe inconsistencies
  const topInconsistencies = inconsistencies
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.ceil(inconsistencies.length * 0.1));
  
  for (const inc of topInconsistencies) {
    const prompt = `FIX INCONSISTENCY:
    
Sentence 1 (${inc.category1}): "${inc.sentence}"
Sentence 2 (${inc.category2}): "${inc.similar}"

These sentences are ${(inc.similarity * 100).toFixed(1)}% similar but in different categories. Which category is CORRECT?

Available: ${categories.join(', ')}

Definitions: ${JSON.stringify(categoryDefinitions[inc.category1])}, ${JSON.stringify(categoryDefinitions[inc.category2])}

Reply with ONLY the correct category name.`;
    
    const messages = [{ role: 'user', content: prompt }];
    const response = await callLongCatAPI(apiKey, messages, 500);
    const correctedCategory = response.trim();
    
    if (categories.includes(correctedCategory)) {
      currentCategories[inc.sentenceIndex] = correctedCategory;
      currentCategories[inc.similarIndex] = correctedCategory;
      addLog(`Fixed inconsistency: Both sentences now in ${correctedCategory}`, 'success');
    }
  }
  
  return currentCategories;
}

function calculateConfidence(categorizedSentences, allSentences) {
  const uncategorizedCount = categorizedSentences['Uncategorized']?.length || 0;
  const categorizedCount = allSentences.length - uncategorizedCount;
  return Math.round((categorizedCount / allSentences.length) * 100);
}

function identifyPotentialMismatches() {
  const mismatches = [];
  
  // Heuristic checks for potential misclassifications
  const keywords = {
    'Conflict-War': ['soldier', 'battle', 'army', 'war', 'weapon', 'attack'],
    'Government-Politics': ['government', 'politics', 'policy', 'election', 'senator', 'law'],
    'Emotions-Psychology': ['feel', 'angry', 'happy', 'sad', 'emotion', 'psychology'],
    'Health-Medicine': ['doctor', 'medicine', 'health', 'disease', 'hospital', 'patient'],
    'Nature-Environment': ['tree', 'water', 'mountain', 'forest', 'animal', 'weather'],
    'Food-Nutrition': ['food', 'eat', 'cook', 'meal', 'restaurant', 'kitchen']
  };
  
  for (const [category, sentences] of Object.entries(categorizedSentences)) {
    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      
      // Check if sentence contains keywords from OTHER categories
      for (const [otherCat, words] of Object.entries(keywords)) {
        if (otherCat !== category && category !== 'Uncategorized') {
          const hasOtherKeywords = words.some(word => 
            lowerSentence.includes(word) && !lowerSentence.includes(category.toLowerCase().replace('-', ' '))
          );
          
          if (hasOtherKeywords) {
            mismatches.push({
              sentence,
              currentCategory: category,
              reason: `Contains keywords from ${otherCat}`
            });
            break;
          }
        }
      }
    }
  }
  
  return mismatches.slice(0, 50); // Top 50 potential mismatches
}

function displayResults() {
  updateProgress(100, 'Complete! Displaying results...');
  addLog('Rendering final results', 'success');
  
  const container = document.getElementById('categoriesContainer');
  container.innerHTML = '';

  const sortedCategories = Object.entries(categorizedSentences)
    .filter(entry => entry[1].length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const confidence = calculateConfidence(categorizedSentences, allSentences);
  document.getElementById('confidenceScore').textContent = confidence + '%';

  const summaryStats = document.getElementById('summaryStats');
  summaryStats.innerHTML = `
    <div class="summary-card">
      <h3>Summary Statistics</h3>
      <p><strong>Total Sentences:</strong> ${allSentences.length}</p>
      <p><strong>Categories Used:</strong> ${sortedCategories.length} of ${categories.length}</p>
      <p><strong>Largest Category:</strong> ${sortedCategories[0][0]} (${sortedCategories[0][1].length} sentences)</p>
      <p><strong>Uncategorized:</strong> ${categorizedSentences['Uncategorized'] ? categorizedSentences['Uncategorized'].length : 0} sentences</p>
      <p><strong>Confidence Score:</strong> ${confidence}%</p>
    </div>
  `;

  for (const [category, sentences] of sortedCategories) {
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'category';

    const title = document.createElement('h3');
    const percentage = ((sentences.length / allSentences.length) * 100).toFixed(1);
    title.textContent = `${category} (${sentences.length} sentences - ${percentage}%)`;
    categoryDiv.appendChild(title);

    if (categoryDefinitions[category]) {
      const defDiv = document.createElement('div');
      defDiv.className = 'category-definition';
      defDiv.textContent = categoryDefinitions[category];
      categoryDiv.appendChild(defDiv);
    }

    sentences.forEach((sentence, idx) => {
      const sentenceDiv = document.createElement('div');
      sentenceDiv.className = 'sentence';
      
      // Mark low-confidence sentences (very short or uncategorized)
      if (sentence.length < 30 || category === 'Uncategorized') {
        sentenceDiv.classList.add('sentence-low-confidence');
      }
      
      sentenceDiv.innerHTML = `<span class="sentence-num">${idx + 1}.</span> ${sentence}`;
      categoryDiv.appendChild(sentenceDiv);
    });

    container.appendChild(categoryDiv);
  }

  // Display potential mismatches
  const mismatches = identifyPotentialMismatches();
  const mismatchesContainer = document.getElementById('mismatchesContainer');
  
  if (mismatches.length > 0) {
    mismatchesContainer.innerHTML = `
      <div style="background: #fff3cd; padding: 15px; border-radius: 10px; margin-bottom: 20px;">
        <strong>Found ${mismatches.length} potential misclassifications</strong><br>
        These sentences contain keywords that may belong to other categories.
      </div>
    `;
    
    mismatches.forEach(mismatch => {
      const mismatchDiv = document.createElement('div');
      mismatchDiv.className = 'mismatch-item';
      mismatchDiv.innerHTML = `
        <div class="mismatch-sentence">${mismatch.sentence}</div>
        <div class="mismatch-reason">Current: ${mismatch.currentCategory} | Reason: ${mismatch.reason}</div>
      `;
      mismatchesContainer.appendChild(mismatchDiv);
    });
  } else {
    mismatchesContainer.innerHTML = '<p style="color: #28a745;">No major mismatches detected!</p>';
  }

  document.getElementById('resultsSection').style.display = 'block';
}

function downloadResults() {
  const output = {
    metadata: {
      totalSentences: allSentences.length,
      totalCategories: categories.length,
      categoriesUsed: Object.keys(categorizedSentences).filter(k => categorizedSentences[k].length > 0).length,
      uncategorizedCount: categorizedSentences['Uncategorized'] ? categorizedSentences['Uncategorized'].length : 0,
      confidenceScore: calculateConfidence(categorizedSentences, allSentences),
      generatedDate: new Date().toISOString()
    },
    categories: categories,
    categoryDefinitions: categoryDefinitions,
    categorizedSentences: categorizedSentences,
    potentialMismatches: identifyPotentialMismatches()
  };
  
  const dataStr = JSON.stringify(output, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'categorized_sentences_enhanced.json';
  link.click();
  URL.revokeObjectURL(url);
  addLog('Downloaded JSON results', 'success');
}

function downloadMismatchesReport() {
  const mismatches = identifyPotentialMismatches();
  
  if (mismatches.length === 0) {
    alert('No mismatches found!');
    return;
  }
  
  let report = 'POTENTIAL MISCLASSIFICATIONS REPORT\n';
  report += '=====================================\n\n';
  report += `Generated: ${new Date().toLocaleString()}\n`;
  report += `Total Potential Issues: ${mismatches.length}\n\n`;
  
  mismatches.forEach((mismatch, idx) => {
    report += `${idx + 1}. CURRENT CATEGORY: ${mismatch.currentCategory}\n`;
    report += `   SENTENCE: ${mismatch.sentence}\n`;
    report += `   REASON: ${mismatch.reason}\n\n`;
  });
  
  const blob = new Blob([report], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mismatches_report.txt';
  link.click();
  URL.revokeObjectURL(url);
  addLog('Downloaded mismatches report', 'success');
}

function downloadAsPDF() {
  try {
    const { jsPDF } = window.jspdf;
    
    if (!jsPDF) {
      alert('PDF library not loaded. Please refresh the page and try again.');
      return;
    }
    
    addLog('Generating PDF document...');
    const doc = new jsPDF();
    
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    let yPosition = margin;

    function addNewPage() {
      doc.addPage();
      yPosition = margin;
      
      doc.setFontSize(9);
      doc.setTextColor(128, 128, 128);
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
      doc.setTextColor(0, 0, 0);
    }

    // Title page
    doc.setFontSize(28);
    doc.setFont(undefined, 'bold');
    doc.text('Categorized Sentences', pageWidth / 2, 60, { align: 'center' });
    
    doc.setFontSize(12);
    doc.setFont(undefined, 'normal');
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.text(`Generated on ${today}`, pageWidth / 2, 75, { align: 'center' });
    
    doc.setFontSize(10);
    const confidence = calculateConfidence(categorizedSentences, allSentences);
    doc.text(`Total Sentences: ${allSentences.length}`, pageWidth / 2, 90, { align: 'center' });
    doc.text(`Categories Used: ${Object.keys(categorizedSentences).filter(k => categorizedSentences[k].length > 0).length}`, pageWidth / 2, 98, { align: 'center' });
    doc.text(`Confidence Score: ${confidence}%`, pageWidth / 2, 106, { align: 'center' });

    addNewPage();

    // Table of Contents
    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text('Table of Contents', margin, yPosition);
    yPosition += 12;

    doc.setFontSize(10);
    
    let categoryIndex = 1;
    const sortedCategories = Object.entries(categorizedSentences)
      .filter(entry => entry[1].length > 0)
      .sort((a, b) => b[1].length - a[1].length);
    
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
      
      yPosition += (wrappedCategory.length * 5) + 3;
      categoryIndex++;
    }

    addNewPage();

    // Category pages
    categoryIndex = 1;
    const categoryPages = {};
    
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
      
      doc.setDrawColor(100, 100, 100);
      doc.line(margin, yPosition, pageWidth - margin, yPosition);
      yPosition += 8;

      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      
      sentences.forEach((sentence, idx) => {
        if (yPosition > pageHeight - 35) {
          addNewPage();
        }

        const sentenceNum = `${idx + 1}.`;
        doc.setFont(undefined, 'bold');
        doc.text(sentenceNum, margin, yPosition);
        
        doc.setFont(undefined, 'normal');
        const textX = margin + 8;
        const wrapped = doc.splitTextToSize(sentence, contentWidth - 8);
        doc.text(wrapped, textX, yPosition);
        
        yPosition += (wrapped.length * 5) + 3;
      });
      
      yPosition += 10;
      categoryIndex++;
    }

    // Add TOC links
    tocEntries.forEach(entry => {
      const targetPage = categoryPages[entry.category];
      if (targetPage) {
        doc.setPage(entry.tocPage);
        doc.setTextColor(0, 0, 255);
        
        const linkText = `${entry.index}. ${entry.category}`;
        doc.textWithLink(linkText, margin + 5, entry.tocY, { 
          pageNumber: targetPage
        });
        
        doc.setTextColor(0, 0, 0);
      }
    });

    doc.save('categorized_sentences_enhanced.pdf');
    addLog('PDF downloaded successfully', 'success');
    
  } catch (error) {
    console.error('PDF Generation Error:', error);
    addLog('PDF generation failed: ' + error.message, 'error');
    alert('Error generating PDF: ' + error.message);
  }
}

async function startProcessing() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const batchSize = parseInt(document.getElementById('batchSize').value);
  const validationPasses = parseInt(document.getElementById('validationPasses').value);
  const sampleSize = parseInt(document.getElementById('sampleSize').value);
  const fileInput = document.getElementById('pdfFile');

  if (!apiKey) return alert('Please enter your LongCat API key');
  if (!fileInput.files[0]) return alert('Please select a PDF file');

  document.getElementById('startBtn').disabled = true;
  document.getElementById('progressSection').style.display = 'block';
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('detailedLog').innerHTML = '';

  try {
    updateProgress(0, 'Extracting text from PDF...');
    addLog('Starting PDF text extraction');
    const text = await extractTextFromPDF(fileInput.files[0]);
    allSentences = splitIntoSentences(text);
    document.getElementById('totalSentences').textContent = allSentences.length;
    addLog('Extracted ' + allSentences.length + ' sentences from PDF', 'success');

    if (allSentences.length === 0) throw new Error('No sentences found in PDF');

    // Build similarity map for consistency checks
    sentenceSimilarityMap = buildSimilarityMap(allSentences);

    // Discover categories with larger sample
    categories = await discoverCategories(apiKey, allSentences, sampleSize);
    document.getElementById('totalCategories').textContent = categories.length;
    
    // Create detailed definitions
    categoryDefinitions = await createCategoryDefinitions(apiKey, categories, allSentences);

    // Initialize results storage
    categorizedSentences = {};
    categories.forEach(cat => categorizedSentences[cat] = []);
    
    const totalBatches = Math.ceil(allSentences.length / batchSize);
    let allCategorizationResults = new Array(allSentences.length);

    // Multi-pass categorization
    for (let pass = 1; pass <= validationPasses; pass++) {
      document.getElementById('currentPass').textContent = pass;
      addLog(`Starting pass ${pass} of ${validationPasses}`, 'info');
      
      for (let i = 0; i < totalBatches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, allSentences.length);
        const batch = allSentences.slice(start, end);

        let batchCategories;
        if (pass === 1) {
          batchCategories = await categorizeBatch(apiKey, batch, categories, categoryDefinitions, i, totalBatches, pass);
        } else {
          const currentBatchCategories = allCategorizationResults.slice(start, end);
          batchCategories = await validateAndRefineBatch(apiKey, batch, currentBatchCategories, categories, categoryDefinitions, i, totalBatches, pass);
        }
        
        // Store results
        for (let j = 0; j < batch.length; j++) {
          allCategorizationResults[start + j] = batchCategories[j];
        }

        document.getElementById('processedCount').textContent = end;
        await new Promise(res => setTimeout(res, 1000)); // Rate limiting
      }
      
      addLog(`Completed pass ${pass}`, 'success');
    }

    // Final consistency check
    addLog('Running final consistency verification...');
    allCategorizationResults = await consistencyCheckPass(
      apiKey, allSentences, categories, categoryDefinitions, allCategorizationResults
    );

    // Build final categorized sentences
    categorizedSentences = {};
    categories.forEach(cat => categorizedSentences[cat] = []);
    
    allSentences.forEach((sentence, idx) => {
      const category = allCategorizationResults[idx];
      if (!categorizedSentences[category]) {
        categorizedSentences[category] = [];
      }
      categorizedSentences[category].push(sentence);
    });

    addLog('Categorization complete!', 'success');
    displayResults();
    
  } catch (error) {
    showError(error.message);
    console.error(error);
  } finally {
    document.getElementById('startBtn').disabled = false;
  }
}