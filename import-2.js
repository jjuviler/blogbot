$(document).ready(function() {
    const $dropArea = $('#drop-area');
    const $fileInput = $('#fileElem');

    function shouldHandleEvent() {
        return $('#primaryKeyword').val().trim().length > 0;
    }

    function handleDragEvent() {
        var inputText = $('#primaryKeyword').val().trim();
        if (inputText.length === 0) {
            $('#primaryKeyword').addClass('glow');
        }
    }

    function removeGlowEffect() {
        $('#primaryKeyword').removeClass('glow');
    }

    $dropArea.on('dragover', function(event) {
        event.stopPropagation();
        event.preventDefault();
        if (!shouldHandleEvent()) {
            handleDragEvent();
        } else {
            event.originalEvent.dataTransfer.dropEffect = 'copy';
            $(this).css('background-color', '#ffcec2');
        }
    });

    $dropArea.on('dragleave', function(event) {
        $(this).css('background-color', '');
        removeGlowEffect();
    });

    $dropArea.on('drop', function(event) {
        event.stopPropagation();
        event.preventDefault();
        if (!shouldHandleEvent()) {
            handleDragEvent();
        } else {
            $(this).css('background-color', '');
            const files = event.originalEvent.dataTransfer.files;
            $dropArea.removeClass('dragover');
            if (files.length) {
                handleFile(files[0]);
            }
        }
        removeGlowEffect();
    });

    $fileInput.on('change', function() {
        if ($(this).prop('files').length && shouldHandleEvent()) {
            handleFile($(this).prop('files')[0]);
        }
    });

    $dropArea.on('click', function(event) {
        if (!shouldHandleEvent()) {
            event.preventDefault();
            return;
        }
        $fileInput.click();
    });
});

function handleFile(file) {
    JSZip.loadAsync(file)
        .then(zip => processHTMLFile(zip))
        .then(({ zip, imgDetails }) => processImagesAndSave(zip, imgDetails))
        .catch(err => console.error('Error processing zip file:', err));
}

function processHTMLFile(zip) {
    let imgDetails = [];
    const htmlFileName = Object.keys(zip.files).find(filename => filename.endsWith('.html'));
    if (htmlFileName) {
        return zip.files[htmlFileName].async('string')
            .then(htmlContent => {
                imgDetails = createImageNameObject(htmlContent);
                processHTMLCode(htmlContent, imgDetails);
                return { zip, imgDetails };
            });
    } else {
        return Promise.reject('No HTML file found.');
    }
}

function processImagesAndSave(originalZip, imgDetails) {
    const newZip = new JSZip();
    const imageFilenames = Object.keys(originalZip.files).filter(filename => filename.match(/\.(png|jpg|jpeg|gif|tiff|tif)$/i));
    const imagePromises = imageFilenames.map(filename => processImageFile(originalZip.files[filename], imgDetails, newZip));

    Promise.all(imagePromises).then(() => {
        const primaryKeyword = $('#primaryKeyword').val().trim().replace(/\s+/g, '-');
        const zipFilename = `compressed-images-${primaryKeyword}.zip`;
        newZip.generateAsync({ type: 'blob' }).then(content => {
            saveAs(content, zipFilename); // Use FileSaver.js to save the new ZIP
        });
    }).catch(err => console.error('Error processing images:', err));
}

function processImageFile(file, imgDetails, newZip) {
    return file.async('blob').then(blob => {
        const fileName = file.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();
        const detail = imgDetails.find(d => fileName.includes(d.oldImgName + '.'));

        if (detail) {
            const newFileName = `${detail.newImgName}.${fileExtension === 'gif' ? 'gif' : 'webp'}`;
            if (fileExtension === 'gif') {
                newZip.file(newFileName, blob, { binary: true });
            } else {
                return convertImageToWebP(blob).then(webpBlob => {
                    newZip.file(newFileName, webpBlob, { binary: true });
                }).catch(err => {
                    console.error(`Error converting ${fileName}:`, err);
                });
            }
        } else {
            console.warn(`No matching detail for ${fileName}`);
        }
    }).catch(err => {
        console.error(`Error processing file ${file.name}:`, err);
    });
}



