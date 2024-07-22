var tocItems = [];

function tableOfContents(htmlString) {
  tocItems = [];
  htmlString = addAnchorsFeaturedSnippets(htmlString);
  htmlString = addAnchorsH2s(htmlString);
  reorderTocItems(htmlString);
  htmlString = addTOC(htmlString);
  return htmlString;
}

function addAnchorsFeaturedSnippets(htmlString) {
  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Get all paragraph elements
  const paragraphs = doc.querySelectorAll('p');

  paragraphs.forEach(paragraph => {
    // Check if the paragraph contains "ftsnippet" (case insensitive)
    if (paragraph.textContent.toLowerCase().includes('ftsnippet')) {
      // Extract the anchorId from the paragraph
      const headerMatch = paragraph.outerHTML.match(/header:\s*"(.*?)"/i);
      if (headerMatch) {
        let anchorId = headerMatch[1];
        // Save the original content for the TOC
        const originalContent = anchorId;
        // Convert anchorId to slug format
        anchorId = anchorId
          .replace(/<\/?[^>]+(>|$)/g, "")
          .replace(/\s+/g, '-')
          .replace(/[^a-zA-Z0-9-]+/g, '')
          .replace(/--+/g, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase();

        // Add to TOC items
        tocItems.push({ content: originalContent, id: anchorId });

        // Create the anchor element
        const anchor = doc.createElement('a');
        anchor.id = anchorId;
        anchor.setAttribute('data-hs-anchor', 'true');

        // Insert the anchor element before the paragraph
        paragraph.parentNode.insertBefore(anchor, paragraph);
      }
    }
  });

  // Return the modified HTML string
  return doc.body.innerHTML;
}

function addAnchorsH2s(htmlString) {
  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Get all h2 elements
  const h2Elements = doc.querySelectorAll('h2');

  h2Elements.forEach(h2 => {
    // Get the text content inside the h2 element
    let anchorId = h2.textContent;
    // Save the original content for the TOC
    const originalContent = anchorId;
    // Convert anchorId to slug format
    anchorId = anchorId
      .replace(/<\/?[^>]+(>|$)/g, "")
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9-]+/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

    // Add to TOC items
    tocItems.push({ content: originalContent, id: anchorId });

    // Create the anchor element
    const anchor = doc.createElement('a');
    anchor.id = anchorId;
    anchor.setAttribute('data-hs-anchor', 'true');

    // Insert the anchor element before the h2 element
    h2.parentNode.insertBefore(anchor, h2);
  });

  // Return the modified HTML string
  return doc.body.innerHTML;
}

function reorderTocItems(htmlString) {
  // Create a map to store the index of each id in the htmlString
  const indexMap = {};

  tocItems.forEach(item => {
    const index = htmlString.indexOf(item.id);
    if (index !== -1) {
      indexMap[item.id] = index;
    }
  });

  // Sort tocItems based on the index in the htmlString
  tocItems.sort((a, b) => {
    return (indexMap[a.id] || Infinity) - (indexMap[b.id] || Infinity);
  });
}

function addTOC(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  
  const fragment = doc.createDocumentFragment();
  const div = doc.createElement('div');
  div.innerHTML = htmlString;
  fragment.appendChild(div);

  // Create a Table of Contents
  const tocParagraph = doc.createElement('p');
  tocParagraph.innerHTML = '<strong>Table of Contents</strong>';
  const tocList = doc.createElement('ul');

  tocItems.forEach(item => {
    const li = doc.createElement('li');
    const a = doc.createElement('a');
    a.textContent = item.content;
    a.href = `#${item.id}`;
    li.appendChild(a);
    tocList.appendChild(li);
  });

  // Find the first anchor with the attribute data-hs-anchor="true"
  const firstAnchor = div.querySelector('a[data-hs-anchor="true"]');
  if (firstAnchor) {
    firstAnchor.parentNode.insertBefore(tocList, firstAnchor);
    firstAnchor.parentNode.insertBefore(tocParagraph, tocList);
  }

  return div.innerHTML;
}


