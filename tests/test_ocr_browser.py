"""Real bundled OCR checks. Translation and account traffic remains mocked."""
import base64
from io import BytesIO
import os

import pytest

from test_browser import base_url, browser_page, page, ready, select_words

pytestmark=pytest.mark.skipif(os.getenv('RUN_BROWSER_TESTS')!='1',reason='Opt-in real OCR browser checks')


def printed_image(page,format='png'):
    data=page.evaluate("""format=>{
      const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=520;
      const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,1400,520);
      context.fillStyle='#d9e9f7';context.fillRect(20,20,1360,480);
      context.fillStyle='#111';context.font='72px Arial';
      context.fillText('Det er lige meget.',80,140);
      context.fillText('Åse så et æble på en ø.',80,280);
      return canvas.toDataURL('image/'+format,.98).split(',')[1];
    }""",format)
    return base64.b64decode(data)


def image_pdf(jpeg):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject,NameObject,NumberObject,DictionaryObject
    writer=PdfWriter();page=writer.add_blank_page(width=700,height=260)
    image=DecodedStreamObject();image.set_data(jpeg)
    image.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),
                  NameObject('/Width'):NumberObject(1400),NameObject('/Height'):NumberObject(520),
                  NameObject('/ColorSpace'):NameObject('/DeviceRGB'),NameObject('/BitsPerComponent'):NumberObject(8),
                  NameObject('/Filter'):NameObject('/DCTDecode')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Scan'):writer._add_object(image)})})
    stream=DecodedStreamObject();stream.set_data(b'q 700 0 0 260 0 0 cm /Scan Do Q')
    page[NameObject('/Contents')]=writer._add_object(stream)
    out=BytesIO();writer.write(out);return out.getvalue()


def track_recognition(page):
    page.set_default_timeout(90000)
    page.evaluate("""()=>{
      window.ocrCalls=0;window.ocrTerminated=0;
      const engines=new WeakSet(),post=Worker.prototype.postMessage,stop=Worker.prototype.terminate;
      Worker.prototype.postMessage=function(message,...args){
        if(message?.action==='recognize'){window.ocrCalls++;engines.add(this);}
        return post.call(this,message,...args);
      };
      Worker.prototype.terminate=function(...args){if(engines.has(this))window.ocrTerminated++;return stop.apply(this,args);};
    }""")


def recognized(page):
    page.wait_for_function("""()=>document.querySelector('.ocrLayer .word') ||
      /Recognition failed|Could not recognize|No readable text/.test(document.getElementById('app-status').textContent)""")
    assert page.locator('.ocrLayer .word').count()>0,page.locator('#app-status').inner_text()
    ready(page)


def test_multicolumn_dialogues_keep_their_own_lines_and_word_positions(page):
    image=page.evaluate("""()=>{
      const canvas=document.createElement('canvas');canvas.width=1500;canvas.height=650;
      const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1500,650);
      const columns=[['DIALOG 1','A: Hej Mette!','B: Hej Louise!','A: Hvordan går det?','B: Det går godt.'],
        ['DIALOG 3','A: Undskyld, vil De','ikke sidde ned?','B: Ellers tak, jeg skal','af næste gang.'],
        ['DIALOG 6','A: Hej! Må jeg bede','om en stor kaffe?','B: Jo, selvfølgelig.','A: Mange tak.']];
      for(let i=0;i<3;i++){
        c.fillStyle='#e8efd6';c.fillRect(i*500+20,20,460,570);
        c.fillStyle='#111';c.font='32px Arial';
        columns[i].forEach((line,j)=>c.fillText(line,i*500+45,85+j*85));
      }
      return canvas.toDataURL().split(',')[1];
    }""")
    page.locator('#file-input').set_input_files({'name':'dialogues.png','mimeType':'image/png','buffer':base64.b64decode(image)})
    recognized(page)
    words=page.locator('.ocrLayer .word').evaluate_all("""elements=>elements.map(e=>({
      text:e.textContent,paragraph:e.dataset.paragraph,x:parseFloat(e.style.left)
    }))""")
    text=' '.join(word['text'] for word in words)
    assert text.index('Mette')<text.index('Louise')<text.index('Undskyld')<text.index('kaffe')
    paragraphs={}
    for word in words:
        paragraphs.setdefault(word['paragraph'],set()).add(int(word['x']//(100/3)))
    assert all(len(columns)==1 for columns in paragraphs.values()),paragraphs


@pytest.mark.parametrize('format',['png','jpeg','webp'])
def test_image_ocr_preserves_appearance_danish_words_and_zoom_cache(page,format):
    track_recognition(page)
    page.locator('#file-input').set_input_files({'name':f'dansk.{format}','mimeType':f'image/{format}','buffer':printed_image(page,format)})
    recognized(page)
    assert page.locator('#reading-mode option:checked').inner_text()=='Original image'
    assert page.locator('.ocrLayer').inner_text().find('Åse')>=0
    assert page.evaluate('window.ocrCalls')==1
    canvas=page.locator('.pdf-page>canvas')
    color=canvas.evaluate('canvas=>Array.from(canvas.getContext("2d").getImageData(Math.floor(canvas.width*.025),Math.floor(canvas.height*.06),1,1).data)')
    assert all(abs(color[i]-expected)<=4 for i,expected in enumerate([217,233,247]))
    word=page.locator('.ocrLayer .word').filter(has_text='lige')
    bounds,original=word.bounding_box(),canvas.bounding_box()
    expected_x=page.evaluate('()=>{const c=document.createElement("canvas").getContext("2d");c.font="72px Arial";return 80+c.measureText("Det er ").width;}')
    assert abs(bounds['x']-original['x']-expected_x*original['width']/1400)<20
    word.hover();assert page.locator('#tooltip').inner_text()=="It doesn't matter"
    select_words(page,'lige','meget')
    assert page.locator('#tooltip').inner_text()=="It doesn't matter"
    page.screenshot(path=f'test-results/ocr-image-{format}.png',full_page=True)
    count=len(page.preparations)
    page.locator('#pdf-zoom').select_option('1.5')
    page.wait_for_function('()=>document.querySelector(".pdf-page")?.clientWidth===2100')
    assert page.evaluate('window.ocrCalls')==1
    assert len(page.preparations)==count
    page.locator('#reading-mode').select_option('text')
    page.locator('#reader p').first.wait_for()
    assert 'Åse' in page.locator('#reader').inner_text()
    page.locator('#new-document').click()
    page.wait_for_function('()=>window.ocrTerminated===1')


def test_scanned_pdf_gets_real_ocr_word_boxes_and_selection(page):
    track_recognition(page)
    pdf=image_pdf(printed_image(page,'jpeg'))
    page.locator('#file-input').set_input_files({'name':'scan.pdf','mimeType':'application/pdf','buffer':pdf})
    recognized(page)
    assert page.locator('.pdf-page>canvas').is_visible()
    assert page.locator('#document-meta').inner_text()=='scan.pdf'
    assert page.evaluate('window.ocrCalls')==1
    page.locator('.ocrLayer .word').filter(has_text='lige').click()
    assert page.locator('#tooltip').inner_text()=="It doesn't matter"
    page.screenshot(path='test-results/ocr-pdf.png',full_page=True)
    page.locator('#pdf-zoom').select_option('1.5')
    page.wait_for_function('()=>document.querySelector(".pdf-page")?.clientWidth===1050')
    assert page.evaluate('window.ocrCalls')==1
    page.locator('#recognize-page').click()
    page.wait_for_function('()=>window.ocrCalls===2')
    page.locator('#recognize-page').wait_for(state='visible')
    page.locator('.ocrLayer .word').filter(has_text='lige').wait_for()


def test_mixed_pdf_retains_native_page_and_recognizes_scanned_page(page):
    from pypdf import PdfReader,PdfWriter
    from test_documents import pdf_bytes
    track_recognition(page)
    writer=PdfWriter();writer.append(PdfReader(BytesIO(pdf_bytes(['En stille morgen.']))))
    writer.append(PdfReader(BytesIO(image_pdf(printed_image(page,'jpeg')))))
    output=BytesIO();writer.write(output)
    page.locator('#file-input').set_input_files({'name':'mixed.pdf','mimeType':'application/pdf','buffer':output.getvalue()})
    page.locator('.textLayer .word').filter(has_text='morgen').wait_for()
    assert page.locator('.ocrLayer').count()==0
    page.locator('#pdf-next').click();recognized(page)
    assert page.locator('#pdf-page').input_value()=='2'
    assert page.locator('.ocrLayer .word').filter(has_text='lige').count()==1
    assert page.evaluate('window.ocrCalls')==1
    page.locator('#pdf-previous').click()
    page.locator('.textLayer .word').filter(has_text='morgen').wait_for()
    assert page.locator('.ocrLayer').count()==0
