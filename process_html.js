// process_html.js

function processHTMLCode(htmlString, imgDetails) {
	htmlString = updateImageSources(htmlString, imgDetails); // first, update image srcs to match their new URLs
    htmlString = cleanHTML(htmlString, imgDetails);			 // format the HTML for COS
    if ($('#addTOC').is(':checked')) {
        htmlString = tableOfContents(htmlString);           // add a TOC section
    }			 
    checkHTML(htmlString);									 // check for style/formatting issues that need attention
    printCleanedHTML(htmlString);
}

function printCleanedHTML (htmlString) {
    let beautifiedHtml = html_beautify(htmlString, {
        indent_size: 2,
        space_in_empty_paren: true
    });
    $('#fileContents').val(beautifiedHtml);
}

// =====================================
// ======== HTML Clean functions =======
// =====================================

function cleanHTML(htmlString, imgDetails) {

    // ===== convert from Google Docs HTML output to CMS-ready HTML =====
    htmlString = createTempStyleAttributes(htmlString); // replace class attributes with style attributes in all tags
    htmlString = keepBody(htmlString);                  // remove all parts of the HTML outside of the <body> tag, including the <body> and </body> tags
    htmlString = removeJunkAnchors(htmlString);         // remove all anchors from tables that google adds for some reason


    // ===== simplify the HTML string =====
    htmlString = convertStyleAttributes(htmlString);    // convert style attributes to semantic tags
    htmlString = removeStyleAttributes(htmlString);     // remove remaining style attributes
    htmlString = removeSpanTags(htmlString);            // remove span tags
    htmlString = removePAttributes(htmlString);         // remove attributes from p tags
    htmlString = removeHeadingAttributes(htmlString);   // remove attributes from heading tags
    htmlString = removeBrTags(htmlString);              // replace each br tag with the closing/opening tag of its parent element (except for br tags inside li tags)

    // ===== implement SEO best practices =====
    htmlString = cleanAnchorHrefs(htmlString);          // remove query strings from URLs
    htmlString = replaceEntities(htmlString);           // replace all HTML entities (other than those for <, >, and &) with characters
    if ($("#checkbox-2").is(":checked")) { htmlString = openLinksInNewTab(htmlString); }    // set all non-anchor links to open in a new tab (and add a rel=noopener attribute)

    // ===== format image HTML =====
    htmlString = cleanImgTags(htmlString);              // remove attributes from image tags except alt and src
    if ($("#checkbox-4").is(":checked")) { htmlString = formatImages(htmlString, imgDetails); } // set all images to 650px wide and centered
    htmlString = isolateImgs(htmlString);               // put each image in its own p element
    htmlString = fixExtraImageText(htmlString);         // remove any extra text content that comes after an <img> element (that is nested inside a <p> element) and moves it to after the <p> element, in its own p element. It also excludes any tags from this moved text
    if ($("#checkbox-6").is(":checked")) { htmlString = htmlString = removeImgName(htmlString); }   // remove instances of paragraphs that only contain "img name" or "image name"
    // ^ examine this
    htmlString = addAltText(htmlString);                // move alt text written under an image to the image's alt attribute
    if ($("#checkbox-5").is(":checked")) { htmlString = formatImageSource(htmlString); }    // format the image source link below an image

    // ===== featured snippets =====
    htmlString = createFeaturedSnippets(htmlString);    // make featured snippets

    // ===== implement style/content best practices ====
    if ($("#checkbox-3").is(":checked")) { htmlString = convertToSmartQuotes(htmlString); } // convert straight quotes to smart quotes unless the straight quotes are in a snippet or CTA
    htmlString = convertHeadingLists(htmlString);                                           // if headings are in a formatted list in the doc, take them out of that formatting
    // if ($("#checkbox-1").is(":checked")) { htmlString = addReadMoreTag(htmlString); }       // add a read more tag after the first paragraph that does not contain an img tag (disabled)

    // ===== additional cleanup =====
    htmlString = removeDuplicateAnchors(htmlString);    // remove cases of multiple adjacent anchor elements in the same hyperlink
    htmlString = extractAnchorTags(htmlString);         // remove cases of whitespace at the start/end of anchor tag content (e.g. <a href="#"> this is a link </a>)
    htmlString = removeTrailingWhitespace(htmlString);  // remove unnecessary whitespace characters at the end of paragraph or heading
    htmlString = removeEmptyTags(htmlString);           // remove empty p, sub, sup, strong, em, a, and heading tags
    htmlString = removeEmptyDivs(htmlString);           // remove empty <div> tags

    // ===== add editor's note =====
    if ($('#addEditorsNote').is(':checked')) { htmlString = addEditorsNote(htmlString); }   // add editor's note to the bottom of the post


    return htmlString;
}

function fixExtraImageText(htmlString) {
    // Create a new DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // Get all <p> elements that contain an <img> tag
    const pElements = Array.from(doc.querySelectorAll('p:has(img)'));

    pElements.forEach(p => {
        // Find the img tag within the <p> tag
        const imgTag = p.querySelector('img');

        // If there's no img tag, skip to the next <p>
        if (!imgTag) return;

        // Get the innerHTML of the <p> tag
        const pInnerHTML = p.innerHTML;

        // Find the position of the closing img tag
        const imgTagHTML = imgTag.outerHTML;
        const imgTagEndIndex = pInnerHTML.indexOf(imgTagHTML) + imgTagHTML.length;

        // Extract the HTML after the img tag (if any)
        const extraContent = pInnerHTML.slice(imgTagEndIndex).trim();

        // If there is extra content, create a new <p> tag to insert the extra content
        if (extraContent) {
            // Strip out any HTML tags from the extra content
            const strippedContent = extraContent.replace(/<[^>]*>/g, '').trim();

            // Create a new <p> element for the stripped content
            if (strippedContent) {
                const newP = doc.createElement('p');
                newP.textContent = strippedContent;

                // Insert the new <p> tag right after the current <p> element
                p.parentNode.insertBefore(newP, p.nextSibling);

                // Remove the extra content from the original <p> element
                p.innerHTML = pInnerHTML.slice(0, imgTagEndIndex);
            }
        }
    });

    // Serialize the document back to a string and return the updated HTML
    return doc.body.innerHTML;
}

function createTempStyleAttributes(htmlString) {
    // Create a new DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // Extract CSS rules from <style> tags
    const styleSheets = doc.querySelectorAll('style');
    let styles = {};
    styleSheets.forEach(sheet => {
        const rules = sheet.sheet.cssRules;
        for (const rule of rules) {
            if (rule.selectorText && rule.style.cssText) {
                rule.selectorText.split(',').forEach(selector => {
                    selector = selector.trim();
                    if (selector.startsWith('.')) { // Class selectors
                        const className = selector.substring(1); // Remove the dot
                        styles[className] = (styles[className] ? styles[className] + ' ' : '') + rule.style.cssText;
                    }
                });
            }
        }
    });

    // Replace class attributes with style attributes
    const elements = doc.querySelectorAll('[class]');
    elements.forEach(el => {
        let inlineStyle = '';
        el.classList.forEach(className => {
            if (styles[className]) {
                inlineStyle += styles[className];
            }
        });
        if (inlineStyle) {
            el.setAttribute('style', inlineStyle.trim());
        }
        el.removeAttribute('class'); // Remove the class attribute
    });

    // Serialize the document back to HTML
    const serializer = new XMLSerializer();
    return serializer.serializeToString(doc);
}

function convertStyleAttributes(htmlString) {
    // Create a new DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // Function to wrap content directly with given tag
    function wrapContentWith(element, tagName) {
        element.innerHTML = `<${tagName}>${element.innerHTML}</${tagName}>`;
    }

    // Scan all elements with style attributes
    const elements = doc.querySelectorAll('[style]');
    elements.forEach(el => {
        const styleContent = el.getAttribute('style');

        // Check for italic font style
        if (styleContent.includes('font-style: italic')) {
            wrapContentWith(el, 'em');
        }
        // Check for bold font weight
        if (styleContent.includes('font-weight: 700')) {
            wrapContentWith(el, 'strong');
        }
        // Check for superscript
        if (styleContent.includes('vertical-align: super')) {
            wrapContentWith(el, 'sup');
        }
        // Check for subscript
        if (styleContent.includes('vertical-align: sub')) {
            wrapContentWith(el, 'sub');
        }

        // Remove the style attribute
        el.removeAttribute('style');
    });

    // Serialize the document back to HTML
    const serializer = new XMLSerializer();
    return serializer.serializeToString(doc);
}

function removeStyleAttributes(htmlString) {
    // Create a new DOM parser
    var parser = new DOMParser();
    // Parse the HTML string into a document
    var doc = parser.parseFromString(htmlString, 'text/html');

    // Get all elements with a style attribute
    var elementsWithStyle = doc.querySelectorAll('[style]');

    // Loop through each element and remove the style attribute
    elementsWithStyle.forEach(function(element) {
        element.removeAttribute('style');
    });

    // Serialize the document back to a string
    var serializedHTML = new XMLSerializer().serializeToString(doc);

    // Return the serialized HTML string
    return serializedHTML;
}


function keepBody(htmlString) {
    // Use a regular expression to find content inside the <body> tags
    const bodyContentRegex = /<body[^>]*>((.|[\n\r])*)<\/body>/im;
    const match = bodyContentRegex.exec(htmlString);

    // If there's a match, clean it up and return; otherwise, return an empty string
    if (match && match[1]) {
        return match[1].trim();
    }
    return "";
}

function removeSpanTags(htmlString) {
    return htmlString.replace(/<span[^>]*>(.*?)<\/span>/gis, "$1");
}

function removePAttributes(htmlString) {
    return htmlString.replace(/<p\s+[^>]*>/gi, '<p>');
}

function removeHeadingAttributes(htmlString) {
    return htmlString.replace(/<(h[1-6])\s+[^>]*>/gi, '<$1>');
}

function removeEmptyTags(htmlString) {
    // Create a temporary element to hold the HTML content
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlString;

    // Define the tags to clean
    const tagsToClean = ['strong', 'em', 'sub', 'sup', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'];

    // Iterate over each tag type
    tagsToClean.forEach(tag => {
        // Find all elements of the tag type
        const elements = tempDiv.querySelectorAll(tag);
        elements.forEach(element => {
            // Check if the element is empty (no content or only whitespace)
            if (!element.textContent.trim() && element.children.length === 0) {
                // Replace the element with its inner content (which is empty)
                element.replaceWith(document.createTextNode(element.innerHTML));
            }
        });
    });

    // Return the cleaned HTML as a string
    return tempDiv.innerHTML;
}

// cleans the href link for each anchor
function cleanAnchorHrefs(htmlString) {
    // Use a regular expression to find all anchor tags and modify their href attributes
    return htmlString.replace(/<a\s+([^>]*href=["'])([^"']*)(["'][^>]*>)/gi, function(match, prefix, href, suffix) {
        // Attempt to isolate the portion after '?q=' and before the first '&'
        const parts = href.split('?q=');
        if (parts.length < 2) return match; // Return original match if '?q=' is not found

        // Further split by '&', if present
        let queryParams = parts[1].split('&');
        // Construct the new href value by appending the extracted query parameter
        let newHref = queryParams[0];

        // Return the modified anchor tag with the new href value
        return `<a ${prefix}${newHref}${suffix}`;
    });
}

function cleanImgTags(htmlString) {
    // Use a regular expression to find all <img> tags and modify their attributes
    return htmlString.replace(/<img\s+[^>]*>/gi, function(tag) {
        const srcMatch = tag.match(/src=["']([^"']*)["']/);
        const altMatch = tag.match(/alt=["']([^"']*)["']/);

        // Rebuild the img tag with only src and alt attributes
        let newTag = '<img';
        if (srcMatch) {
            newTag += ` src="${srcMatch[1]}"`;
        }
        if (altMatch) {
            newTag += ` alt="${altMatch[1]}"`;
        }
        newTag += '>';
        return newTag;
    });
}

function replaceEntities(htmlString) {
    htmlString = htmlString.replace(/&nbsp;|&#160;/g, ' '); 
    htmlString = htmlString.replace(/\u00A0/g, ' ');      
    htmlString = htmlString.replace(/&apos;|&#39;/g, '’');
    htmlString = htmlString.replace(/&lsquo;|&#8216;/g, '‘');    
    htmlString = htmlString.replace(/&rsquo;|&#8217;/g, '’'); 
    htmlString = htmlString.replace(/&ldquo;|&#8220;/g, '“'); 
    htmlString = htmlString.replace(/&rdquo;|&#8221;/g, '”');  
    htmlString = htmlString.replace(/&ndash;|&#8211;/g, '–');  
    htmlString = htmlString.replace(/&mdash;|&#8212;/g, '—');  

    return htmlString;
}

// replace <br> tags with closing/opening tag of the parent element (with the exception of if the br tag is inside an li tag)
function removeBrTags(htmlString) {
  const brRegex = /<br\s*\/?>/gi;
  let result = '';
  let openTags = [];
  let insideLi = false;

  // Function to process each tag
  function processTag(tag) {
    if (tag.startsWith('</')) {
      // If it's a closing tag, pop the last open tag
      const tagName = tag.match(/<\/(\w+)/)[1];
      openTags.pop();
      if (tagName === 'li') {
        insideLi = false;
      }
    } else if (!tag.startsWith('<br')) {
      // If it's an opening tag, push it to the stack
      const tagName = tag.match(/<(\w+)/)[1];
      openTags.push(tagName);
      if (tagName === 'li') {
        insideLi = true;
      }
    }
    return tag;
  }

  // Split the HTML string into parts using the <br> tags
  let parts = htmlString.split(brRegex);

  // Iterate through the parts and reassemble the HTML string
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // Add the replacement string for <br> tags if not inside <li>
      if (openTags.length > 0 && !insideLi) {
        const parentTag = openTags[openTags.length - 1];
        result += `</${parentTag}><${parentTag}>`;
      } else if (insideLi) {
        result += '<br>'; // retain the <br> tag inside <li>
      }
    }
    // Process the current part
    let part = parts[i];
    // Find and process all tags in the current part
    part = part.replace(/<\/?\w+[^>]*>/g, processTag);
    result += part;
  }

  return result;
}


function isolateImgs(htmlString) {

    // Function to wrap content in a specific tag
    function wrapContent(tag, content) {
        return `<${tag}>${content}</${tag}>`;
    }

    // Parse the HTML string using DOMParser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    
    // Locate all <img> elements
    const imgElements = Array.from(doc.querySelectorAll('img'));

    imgElements.forEach(img => {
        // Phase 1: Get the parent element of the img tag
        const imgParent = img.parentNode;

        // Get the outerHTML of the parent element
        const imgParentHTML = imgParent.outerHTML;

        // Phase 2: Get img tag, beforeImgTag, and afterImgTag
        const imgTag = img.outerHTML;

        // Get the HTML of imgParent without the outer tags
        const innerHTML = imgParent.innerHTML;

        // Find the positions of the imgTag within innerHTML
        const imgTagPosition = innerHTML.indexOf(imgTag);
        
        // Extract beforeImgTag and afterImgTag
        const beforeImgTag = innerHTML.slice(0, imgTagPosition);
        const afterImgTag = innerHTML.slice(imgTagPosition + imgTag.length);

        // Phase 3: Create element1 if beforeImgTag is not empty
        let element1 = '';
        if (beforeImgTag.trim()) {
            element1 = wrapContent(imgParent.tagName.toLowerCase(), beforeImgTag);
        }

        // Phase 4: Create element2
        const element2 = wrapContent('p', imgTag);

        // Phase 5: Create element3 if afterImgTag is not empty
        let element3 = '';
        if (afterImgTag.trim()) {
            element3 = wrapContent('p', afterImgTag);
        }

        // Phase 6: Replace imgParent with element1, element2, and element3
        const newContent = [element1, element2, element3].filter(Boolean).join('');
        htmlString = htmlString.replace(imgParentHTML, newContent);
    });

    // Phase 7: Return the modified htmlString
    return htmlString;
}

function convertToSmartQuotes(htmlString) {
  // Create a regular expression to match straight quotes
  var straightQuotesRegex = /("([^"]|\\")*")|('([^']|\\')*')/g;

  // Split the HTML string into segments that are inside and outside of HTML tags and { } characters
  var segments = htmlString.split(/(<\/?[^>]+>)|({[^}]*})/);

  // Define mapping for straight quotes to smart quotes
  var smartQuotesMap = {
    '"': {
      opening: '“',
      closing: '”'
    },
    "'": {
      opening: '‘',
      closing: '’'
    }
  };

  // Iterate through the segments and convert straight quotes to smart quotes
  for (var i = 0; i < segments.length; i++) {
    // Check if the segment is defined and not inside an HTML tag or inside { }
    if (segments[i] && !segments[i].startsWith('<') && !segments[i].startsWith('{')) {
      segments[i] = segments[i].replace(straightQuotesRegex, function(match) {
        // Get the appropriate smart quote based on the straight quote type
        var quoteType = match.charAt(0);
        var smartQuote = smartQuotesMap[quoteType];
        return smartQuote ? smartQuote.opening + match.slice(1, -1) + smartQuote.closing : match;
      });
    }
  }

  return segments.join('');
}

function removeJunkAnchors(htmlString) {
    const regex = /<a\s+[^>]*?\bid=['"][^'"]*['"][^>]*>[\s\S]*?<\/a>/gi;
    return htmlString.replace(regex, '');
}

function removeImgName(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    const paragraphs = doc.querySelectorAll('p');

    paragraphs.forEach(paragraph => {
        const innerText = paragraph.innerHTML.toLowerCase();
        if (innerText.includes('img name:') || innerText.includes('image name:') || innerText.includes('img:')) {
            paragraph.innerHTML = '';
        }
    });

    return doc.body.innerHTML;
}

function removeEmptyLinks(htmlString) {
  // Regex to find <a> tags with only spaces, tabs, or HTML entities like &nbsp; as their content
  htmlString = htmlString.replace(/<a [^>]*?>\s*(&nbsp;)*\s*<\/a>/gi, ' ');

  // Regex to find <a> tags with no content and remove them entirely
  htmlString = htmlString.replace(/<a [^>]*?><\/a>/gi, '');

  return htmlString;
}

function formatImages(htmlString, imgDetails) {
    // Iterate through each image detail object
    imgDetails.forEach(detail => {
        // Determine the width based on the image's dimensions
        const widthPx = detail.height > detail.width ? '450px' : '650px';

        // Create a new img tag with updated styles and attributes
        const newImgTag = `<img src="${detail.newSource}" style="margin-left: auto; margin-right: auto; display: block; width: ${widthPx}; height: auto; max-width: 100%;" title="" loading="lazy">`;

        // Replace the old img tag that matches the src in htmlString
        htmlString = htmlString.replace(new RegExp(`<img[^>]*src=["']${detail.newSource}["'][^>]*>`, 'g'), newImgTag);
    });

    return htmlString;
}

function openLinksInNewTab(htmlString) {
  const pattern = /<a\s+(?:[^>]*?\s+)?href="((?:https?:\/\/)[^"]+)"/gi;
  const replacement = '<a href="$1" rel="noopener" target="_blank"';
  return htmlString.replace(pattern, replacement);
}

function addReadMoreTag(htmlString) {
  // Check if "<!--more-->" is already present. if so, return original string
  if (htmlString.includes("<!--more-->")) { return htmlString; }

  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Get all paragraph elements
  const paragraphs = doc.querySelectorAll('p');

  // Find the first paragraph that does not contain an img element and isn't empty
  let targetParagraph = null;
  paragraphs.forEach(paragraph => {
    if (!paragraph.querySelector('img') && paragraph.textContent.trim() !== '' && !targetParagraph) {
      targetParagraph = paragraph;
    }
  });

  // If a suitable paragraph is found, add the read more tag after it
  if (targetParagraph) {
    const readMoreTag = doc.createComment('more');
    targetParagraph.parentNode.insertBefore(readMoreTag, targetParagraph.nextSibling);
  }

  // Return the modified HTML string
  return doc.body.innerHTML;
}

function addAltText(htmlString) {
    const paragraphs = htmlString.split('</p>');
    const altMarkers = ['[alt]', 'alt:', 'alt text:', 'alternative text:'];

    for (let i = 0; i < paragraphs.length; i++) {
        let altText = null;

        for (const marker of altMarkers) {
            const markerIndex = paragraphs[i].toLowerCase().indexOf(marker);
            if (markerIndex !== -1) {
                altText = paragraphs[i].substring(markerIndex + marker.length).trim();
                altText = altText.replace(/<[^>]+>/g, ''); // Strip out any HTML tags
                break;
            }
        }

        if (altText) {
            // Find the closest previous image tag
            let j = i - 1;
            while (j >= 0 && !paragraphs[j].includes('<img')) {
                j--;
            }

            if (j >= 0) {
                // Find the img tag
                const imgTagRegex = /<img[^>]*>/;
                const imgMatch = paragraphs[j].match(imgTagRegex);
                if (imgMatch) {
                    const imgTag = imgMatch[0];
                    // Check if img tag already has an alt attribute
                    if (imgTag.includes('alt="')) {
                        // Replace existing alt attribute with new alt text
                        const newImgTag = imgTag.replace(/alt="[^"]*"/, `alt="${altText}"`);
                        paragraphs[j] = paragraphs[j].replace(imgTagRegex, newImgTag);
                    } else {
                        // Add alt attribute to img tag
                        const newImgTag = imgTag.slice(0, -1) + ` alt="${altText}">`;
                        paragraphs[j] = paragraphs[j].replace(imgTagRegex, newImgTag);
                    }
                }
            }

            // Remove the paragraph containing the alt marker
            paragraphs.splice(i, 1);
            i--; // Adjust index after removal
        }
    }

    return paragraphs.join('</p>');
}

function addEditorsNote(htmlString) {
  const month = $('#monthSelect').val();
  const year = $('#yearSelect').val();

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  // Find and remove any paragraphs that contain "Editor's note"
  const paragraphs = Array.from(doc.querySelectorAll("p"));
  paragraphs.forEach(p => {
    if (p.textContent.includes("Editor's note:")) {
      p.remove();
    }
  });

  // Find the last paragraph not containing "{{cta"
  const lastValidParagraph = paragraphs.reverse().find(p => !p.textContent.includes("{{cta"));

  // Create the new paragraph
  const newParagraph = doc.createElement("p");
  const em = doc.createElement("em");
  em.textContent = `Editor's note: This post was originally published in ${month} ${year} and has been updated for comprehensiveness.`;
  newParagraph.appendChild(em);

  // Insert the new paragraph if a suitable location is found
  if (lastValidParagraph) {
    lastValidParagraph.insertAdjacentElement('afterend', newParagraph);
  } else if (doc.body) {
    doc.body.appendChild(newParagraph); // Append at the end if no suitable paragraph is found
  }

  // Return the modified HTML string
  return doc.body.innerHTML;
}

function convertHeadingLists(htmlString) {
    // Create a temporary element to parse the HTML string
    let tempElement = document.createElement('div');
    tempElement.innerHTML = htmlString;

    // Find all <ol> elements
    let olElements = tempElement.querySelectorAll('ol');

    olElements.forEach(ol => {
        // Check if the <ol> contains any heading elements
        let heading = ol.querySelector('h1, h2, h3, h4, h5, h6');
        if (heading) {
            // Get the outer HTML of the heading tag
            let headingTag = heading.outerHTML;

            // Get the start attribute value or default to 1
            let listNumber = ol.getAttribute('start') ? parseInt(ol.getAttribute('start')) : 1;

            // Get the inner content of the heading tag
            let innerContent = heading.innerHTML;

            // Modify the headingTag to add listNumber at the front
            let newInnerContent = listNumber + '. ' + innerContent;
            headingTag = headingTag.replace(innerContent, newInnerContent);

            // Replace the entire <ol> element with the modified headingTag
            ol.outerHTML = headingTag;
        }
    });

    // Return the modified HTML string
    return tempElement.innerHTML;
}

function formatImageSource(htmlString) {
    // Use DOMParser to parse the HTML string
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // Use querySelectorAll to get all img elements in htmlString
    const imgElements = doc.querySelectorAll('img');

    imgElements.forEach(img => {
        // Get the element that the img element is nested inside of and assign to imgParagraph
        const imgParagraph = img.closest('p');

        if (imgParagraph) {
            let found = false;
            let hrefValue = '';
            let nextSibling = imgParagraph.nextElementSibling;

            for (let i = 0; i < 4 && nextSibling; i++) {
                if (nextSibling.tagName.toLowerCase() === 'p') {
                    if (nextSibling.querySelector('img')) {
                        // Stop if the paragraph contains an img element
                        break;
                    }

                    const anchor = nextSibling.querySelector('a');

                    if (anchor && /image source/i.test(anchor.textContent)) {
                        hrefValue = anchor.getAttribute('href');

                        // Remove the paragraph element
                        nextSibling.remove();
                        
                        found = true;
                        break;
                    }
                }
                nextSibling = nextSibling.nextElementSibling;
            }

            // If no "image source" anchor tag was found, check for link strings
            if (!found) {
                nextSibling = imgParagraph.nextElementSibling;
                for (let i = 0; i < 4 && nextSibling; i++) {
                    if (nextSibling.tagName.toLowerCase() === 'p') {
                        if (nextSibling.querySelector('img')) {
                            // Stop if the paragraph contains an img element
                            break;
                        }
                        const textContent = nextSibling.textContent;
                        const linkStringMatch = textContent.match(/https?:\/\/[^\s"<]+/);

                        if (linkStringMatch) {
                            hrefValue = linkStringMatch[0];

                            // Remove the paragraph element only if it contains only whitespace and the link
                            if (textContent.trim() === hrefValue) {
                                nextSibling.remove();
                            } else {
                                hrefValue = ''; // Invalidate the hrefValue if there are other characters
                            }
                            
                            break;
                        }
                    }
                    nextSibling = nextSibling.nextElementSibling;
                }
            }

            // If an href value was found and is valid, create a new p element with the "Image Source" link wrapped in an em element
            if (hrefValue) {
                const newParagraph = document.createElement('p');
                newParagraph.style.textAlign = 'center';
                newParagraph.style.fontSize = '12px';

                const emElement = document.createElement('em');
                const newAnchor = document.createElement('a');
                newAnchor.href = hrefValue;
                newAnchor.textContent = 'Image Source';

                emElement.appendChild(newAnchor);
                newParagraph.appendChild(emElement);
                imgParagraph.parentNode.insertBefore(newParagraph, imgParagraph.nextSibling);
            }
        }
    });

    // Serialize the document back to HTML
    return doc.body.innerHTML;
}

function removeTrailingWhitespace(htmlString) {
    // Regular expression to match <p> and <h1> to <h6> elements, ignoring content within tags
    htmlString = htmlString.replace(/(<p[^>]*>|<h[1-6][^>]*>)([\s\S]*?)(<\/p>|<\/h[1-6]>)/g, function(match, openingTag, content, closingTag) {
        // Match all HTML tags inside the content and store their positions
        const tagMatches = [...content.matchAll(/<[^>]*>/g)];
        
        // Remove all HTML tags from the content to analyze the text
        const strippedContent = content.replace(/<[^>]*>/g, '');
        
        // Find the index of the last non-whitespace character in the stripped content
        const lastNonWhitespaceIndex = strippedContent.search(/\S(?=\s*$)/);

        if (lastNonWhitespaceIndex !== -1) {
            // Trim any extra whitespace from the content after the last non-whitespace character
            const cleanContent = strippedContent.slice(0, lastNonWhitespaceIndex + 1);

            // Reinsert the HTML tags in their original positions
            let finalContent = cleanContent;
            tagMatches.forEach(match => {
                const position = match.index;
                finalContent = finalContent.slice(0, position) + match[0] + finalContent.slice(position);
            });

            // Return the cleaned content with the opening and closing tags intact
            return openingTag + finalContent + closingTag;
        }

        return match; // If no non-whitespace characters are found, return the match as-is
    });

    return htmlString;
}

function removeEmptyDivs(htmlString) {
    // find <div> elements that contain only whitespace, HTML tags, or both
    return htmlString.replace(/<div>(\s|<[^>]+>)*<\/div>/g, '');
}

// removes cases of multiple anchor elements for the same hyperlink
function removeDuplicateAnchors(htmlString) {
  // Regex pattern to match two adjacent anchor tags with the same href
  const anchorPattern = /<a\s+([^>]*href=["']([^"']*)["'][^>]*)>([^<]*)<\/a>\s*<a\s+([^>]*href=["']\2["'][^>]*)>([^<]*)<\/a>/g;
  
  // Replace the matching adjacent anchor tags by merging their content into one
  return htmlString.replace(anchorPattern, (match, firstAttrs, href, firstText, secondAttrs, secondText) => {
    return `<a ${firstAttrs}>${firstText}${secondText}</a>`;
  });
}


// ==================================
// ======== Style Checks ============
// ==================================

function checkHTML(htmlString) {
    var issueMessages = [];
    var isIssue = false;
    $('#issueBox').hide();

    if (checkDoubleDash(htmlString)) {
        issueMessages.push("Double-hyphens (--) found. Use an em-dash instead of double-hyphens.");
        isIssue = true;
    } 

    if (checkEllipses(htmlString)) {
        issueMessages.push("Make sure all ellipses have a space on both sides.");
        isIssue = true;
    } 
    if (checkVersusVs(htmlString)) {
        issueMessages.push('Make sure "vs." is only used in headings and "versus" is only used in paragraphs.');
        isIssue = true;
    }
    if (checkQueryStrings(htmlString)) {
        issueMessages.push('Remove tracking parameters from all URLs.');
        isIssue = true;
    }
    if (checkH1s(htmlString)) {
        issueMessages.push('Remove H1s from the body of the post (the highest heading should be H2).');
        isIssue = true;
    }
    if (checkH5sH6s(htmlString)) {
        issueMessages.push('Remove H5s and H6s from the body of the post if possible.');
        isIssue = true;
    }
    if (checkHeadingHierarchy(htmlString)) {
        issueMessages.push('Headings may be out of order. Check to make sure that h3s only follow h2s or h3, etc.');
        isIssue = true;
    }
    if (checkLinkWhitespace(htmlString)) {
        issueMessages.push('Check link text for extra whitespace at the start/end of the link.');
        isIssue = true;
    }

    var issueOutput = "";
    $('#issueBox').css('display', 'none');
    $("#issueText").empty();

    if (isIssue) {
        for (let i=0; i<issueMessages.length; i++) {
            issueOutput += '<p>' + issueMessages[i] + '</p>';
        }
        $("#issueText").append(issueOutput);
        $('#issueBox').fadeIn(500);
    }
}

// checks for double dash (--) characters in body text
function checkDoubleDash(htmlString) {
	let insideAngleBrackets = false;
	for (let i = 0; i < htmlString.length; i++) {
		const currentChar = htmlString[i];
    	if (currentChar === "<") {
    		insideAngleBrackets = true;
    	} else if (currentChar === ">") {
    		insideAngleBrackets = false;
    	} else if (!insideAngleBrackets && currentChar === "-" && htmlString[i + 1] === "-") {
    		return true;
    	}
  	}
  return false;
}

// checks for ellipses that do not have a space on both sides
function checkEllipses(htmlString) {
    const regex = /[a-zA-Z0-9](\.\.\.|…)|(\.\.\.|…)[a-zA-Z0-9]/;
    return regex.test(htmlString);
}

// checks for "versus" in headings or "vs." in paragraphs (outside of any nested html tags)
function checkVersusVs(htmlString) {
    // Modified regex to find "vs." in a paragraph, excluding cases where "vs." is inside HTML tags
    const vsInParagraph = /<p[^>]*>(?:(?!<\/p>|<[^>]*>)[\s\S])*vs\.(?:(?!<\/p>|<[^>]*>)[\s\S])*<\/p>/i;

    // Modified regex to find "versus" in headings <h2>...</h2> to <h6>...</h6>, excluding cases where "versus" is inside HTML tags
    const versusInHeading = /<(h[2-6])[^>]*>(?:(?!<\/\1>|<[^>]*>)[\s\S])*versus(?:(?!<\/\1>|<[^>]*>)[\s\S])*<\/\1>/i;

    // Return true if either regex matches the HTML string, otherwise return false
    return vsInParagraph.test(htmlString) || versusInHeading.test(htmlString);
}


// check for instances of "?" in URLs (excluding youtube video links, which require a query string)
function checkQueryStrings(htmlString) {
    const regex = /<a[^>]*href="([^"]*\?[^"]*)"[^>]*>/g;
    let match;
    while ((match = regex.exec(htmlString)) !== null) {
        const url = match[1];
        if (!url.includes("youtube.com")) {
            return true; // Found a non-YouTube link with a query string
        }
    }
    return false; // No non-YouTube links with query strings found
}

// check for instances of <h1>
function checkH1s(htmlString) {
    const regex = /<h1\b[^>]*>.*?<\/h1>/i;
    return regex.test(htmlString);
}

// check for instances of <h5> or <h6>
function checkH5sH6s(htmlString) {
    // Regular expression to match h5 and h6 tags
    const regex = /<h[56]\b[^>]*>.*?<\/h[56]>/i;

    // Test the HTML string with the regex
    return regex.test(htmlString);
}

// checks that heading tags are in the correct order (h3s only follow h2s or h3s, etc.)
function checkHeadingHierarchy(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  // Convert paragraphs with 'ftsnippet' to h2 elements
  const paragraphs = doc.querySelectorAll("p");
  paragraphs.forEach(p => {
    if (p.textContent.toLowerCase().includes("ftsnippet")) {
      const newH2 = doc.createElement("h2");
      newH2.innerHTML = p.innerHTML; // Preserve the content of the paragraph
      p.replaceWith(newH2);
    }
  });

  const headings = doc.querySelectorAll("h2, h3, h4");

  if (headings.length === 0) return false;  // Assuming no headings is considered not okay

  // Return false if the first heading is not an h2
  if (headings[0].tagName.toLowerCase() !== 'h2') return true;

  let prevHeadingLevel = 2;  // Start from h2
  for (let heading of headings) {
    const currHeadingLevel = parseInt(heading.tagName.substring(1));
    if (currHeadingLevel > prevHeadingLevel + 1) {
      return true; // No skips in the sequence allowed
    }
    prevHeadingLevel = currHeadingLevel;
  }

  return false; // All checks pass, return true as hierarchy is correct
}

// check for whitespace character on either side of link text
function checkLinkWhitespace(htmlString) {
    const openTagPattern = /<a(\s+[^>]*)?>\s+/g;
    const closeTagPattern = /\s+<\/a>/g;
    let matchFound = false;

    let openMatch;
    while ((openMatch = openTagPattern.exec(htmlString)) !== null) {
        matchFound = true;
    }

    let closeMatch;
    while ((closeMatch = closeTagPattern.exec(htmlString)) !== null) {
        matchFound = true;
    }

    return matchFound;
}

