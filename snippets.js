// snippets.js

// add featured snippet code to the body of the post
function createFeaturedSnippets(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // Get all h2 elements
    const h2s = Array.from(doc.querySelectorAll('h2'));

    h2s.forEach((h2, index) => {
        if (h2.textContent.includes('[fs]')) {
            // Clean the h2 text
            const cleanH2Text = h2.textContent.replace('[fs]', '').trim();
            let nextElement = h2.nextElementSibling;
            let items = [cleanH2Text];
            let foundNumberedH3 = false;

            // Continue until the next h2 or the end of the document
            while (nextElement && !(nextElement.tagName === 'H2')) {
                if (nextElement.tagName === 'H3' && /^\d+\./.test(nextElement.textContent)) {
                    foundNumberedH3 = true;
                    items.push(nextElement.textContent.replace(/^\d+\.\s*/, ''));
                }
                nextElement = nextElement.nextElementSibling;
            }

            // Determine snippet type based on whether a numbered h3 was found
            let newHtml;
            if (foundNumberedH3) {
                newHtml = createFsListCode(items);
            } else {
                // Find the first paragraph after h2 if no numbered h3 is found
                nextElement = h2.nextElementSibling;
                while (nextElement && !(nextElement.tagName === 'H2' || nextElement.tagName === 'P')) {
                    nextElement = nextElement.nextElementSibling;
                }
                if (nextElement && nextElement.tagName === 'P') {
                    items.push(nextElement.textContent);
                    nextElement.remove(); // Remove this paragraph
                }
                newHtml = createFsParagraphCode(items);
            }

            // Replace the h2 element directly with new HTML content
            const range = document.createRange();
            const frag = range.createContextualFragment(newHtml);
            h2.replaceWith(frag);
        }
    });

    return doc.body.innerHTML;
}

// creates paragraph featured snippet code
function createFsParagraphCode(items) {
  return '{% module "featured_snippet" path="/_Web Team Assets/Component Modules/modules/featuredSnippet", label="featuredSnippet", content_type="paragraph", paragraph="' + items[1] + '", header="' + items[0] + '", style={ "theme": "white", "paddingTop": "xs", "paddingBottom": "xs" } %}';
}

// creates list featured snippet code
function createFsListCode(items) {
  var itemsStr = '';
  for (let i = 1; i < items.length; i++) {
    itemsStr += '"' + items[i] + '"';
    if (i != items.length - 1) { itemsStr += ', '; }
  }

  return '{% module "featured_snippet" path="/_Web Team Assets/Component Modules/modules/featuredSnippet", label="featuredSnippet", listItems=[ ' + itemsStr + ' ], content_type="ordered_list", header="' + items[0] + '", style={ "theme": "white", "paddingTop": "xs", "paddingBottom": "xs" } %}';
}


