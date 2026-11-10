"""Opt-in real Chrome checks. Groq calls are always intercepted, never live."""
import os
import json
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import pytest

pytestmark=pytest.mark.skipif(os.getenv("RUN_BROWSER_TESTS")!="1",reason="Opt-in real browser checks")
PREFIX = "/DanskReadingApp/"
GROQ = "https://api.groq.com/openai/v1/chat/completions"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def base_url():
    class StaticHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / "static"), **kwargs)

        def do_GET(self):
            if not urlsplit(self.path).path.startswith(PREFIX):
                self.send_error(404)
                return
            self.path = "/" + self.path[len(PREFIX):]
            super().do_GET()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), StaticHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}{PREFIX}"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def prepared(body,translation=None):
    selection = "messages" in body and "exactly ONE entry" in body["messages"][0]["content"]
    if "messages" in body:
        body = json.loads(body["messages"][1]["content"])
    tokens=body["words"]
    target=set(body["target_word_ids"])
    if selection:
        selected=[tokens[i]["text"] for i in sorted(target)]
        meaning = "It is" if selected == ["Det","er"] else "It doesn't matter. She looked up the word." if len(selected)>4 else "It doesn't matter"
        entries=[{"word_ids":sorted(target),"translation":translation or meaning,"uncertain":False}]
        return {"choices":[{"message":{"content":json.dumps({"entries":entries})}}],"usage":{"total_tokens":1}}
    expressions=[]
    for first,last,meaning in [("lige","meget",{"Italian":"Non importa","Polish":"To nie ma znaczenia"}.get(body["language"],"It doesn't matter")),("slog","op","looked up")]:
        for token in tokens:
            if token["text"]==first:
                end=next((w for w in tokens if w["id"]>token["id"] and w["text"]==last),None)
                if end:expressions.append(([token["id"],end["id"]],meaning))
    assigned=set();entries=[]
    for token in tokens:
        if token["id"] not in target or token["id"] in assigned:continue
        ids,meaning=next(((ids,meaning) for ids,meaning in expressions if token["id"] in ids),([token["id"]],{"Farvel":"Goodbye","Hun":"she"}.get(token["text"],token["text"])))
        assigned.update(target.intersection(ids))
        entries.append({"word_ids":ids,"translation":translation or meaning,"uncertain":False})
    return {"choices":[{"message":{"content":json.dumps({"entries":entries})}}],"usage":{"total_tokens":1}}


@pytest.fixture
def browser_page(base_url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path=os.getenv("BROWSER_EXECUTABLE",r"C:\Program Files\Google\Chrome\Application\chrome.exe"))
        page=browser.new_page(viewport={"width":1440,"height":1000});page.set_default_timeout(10000)
        errors,ad_hoc,missing=[],[],[]
        page.preparations=[]
        page.on("pageerror",lambda error:errors.append(str(error)))
        page.on("response",lambda response:missing.append(response.url) if response.url.startswith(base_url) and response.status>=400 else None)
        def isolated(route):
            if route.request.url.startswith(base_url) and "/api/" not in route.request.url:
                route.continue_()
            else:
                ad_hoc.append(route.request.url)
                route.abort()
        page.route("**/*",isolated)
        def background(route):
            body=route.request.post_data_json
            assert body["response_format"]["type"]=="json_schema"
            page.preparations.append(json.loads(body["messages"][1]["content"]))
            route.fulfill(json=prepared(body))
        page.route(GROQ,background)
        page.goto(base_url);Path("test-results").mkdir(exist_ok=True)
        yield page
        browser.close()
        assert errors==[],f"Uncaught browser errors: {errors}"
        assert ad_hoc==[],f"Unexpected network requests: {ad_hoc}"
        assert missing==[],f"Missing static resources under the project path: {missing}"


@pytest.fixture
def page(browser_page):
    browser_page.locator("#api-key").fill("gsk_browser_test_only")
    browser_page.locator("#api-key-form").get_by_role("button",name="Continue",exact=True).click()
    browser_page.locator("#paste").wait_for(state="visible")
    return browser_page


def ready(page):page.locator("#preparation-status").filter(has_text="Meanings ready").wait_for(state="attached")


def read(page,text="Det er lige meget.\n\nHun slog ordet op.",wait=True):
    page.locator("#paste").fill(text);page.locator("#prepare").click()
    page.locator("#preview-text").wait_for(state="visible");page.locator("#start-reading").click()
    page.locator("#reader-screen").wait_for(state="visible")
    if wait:ready(page)


def select_words(page,first,last,click=True):
    page.evaluate("""([first,last])=>{
      const all=[...document.querySelectorAll('#reader .word')];
      const range=document.createRange();range.setStartBefore(all.find(w=>w.textContent===first));range.setEndAfter(all.find(w=>w.textContent===last));
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      document.getElementById('reader').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    }""",[first,last])
    if click:page.locator("#selection-translate").click()


def test_username_signup_login_and_disconnect_keep_secrets_in_memory(browser_page):
    page=browser_page
    page.screenshot(path="test-results/auth-gate.png",full_page=True)
    user={"id":"11111111-1111-4111-8111-111111111111","email":"reader_name@usernames.danskreader.invalid"}
    metadata={}
    requests=[]
    def account(route):
        body=route.request.post_data_json
        requests.append((route.request.url,body))
        if "/settings" in route.request.url:
            route.fulfill(json={"mailer_autoconfirm":True})
        elif "/username_available" in route.request.url:
            route.fulfill(json=True)
        elif "/signup" in route.request.url:
            metadata.update(body["data"])
            assert body["email"]==user["email"]
            route.fulfill(json={"access_token":"mock-account-session","user":{**user,"user_metadata":metadata}})
        elif "/token" in route.request.url:
            route.fulfill(json={"access_token":"mock-account-session","user":{**user,"user_metadata":metadata}})
        elif "/logout" in route.request.url:
            route.fulfill(status=204,body="")
        else:
            pytest.fail("Unexpected account operation")
    page.route(re.compile(r"https://[^/]+\.supabase\.co/(auth|rest)/v1/.*"),account)
    page.locator('[data-auth-mode="signup"]').click()
    assert page.locator("#signup-email").get_attribute("type")=="text"
    page.locator("#signup-email").fill("reader_name")
    page.locator("#signup-password").fill("a long test password")
    page.locator("#signup-password-confirm").fill("a long test password")
    page.locator("#signup-key").fill("gsk_account_test_only")
    page.locator("#signup-form").get_by_role("button",name=re.compile("create|sign up",re.I)).click()
    page.locator("#paste").wait_for(state="visible")
    assert sum("/signup" in url for url,_body in requests)==1
    assert "gsk_account_test_only" not in json.dumps(metadata)
    assert metadata["dansk_vault"]["version"]==1
    page.locator("#disconnect").click()
    page.locator('[data-auth-mode="login"]').click()
    page.locator("#login-email").fill("reader_name")
    page.locator("#login-password").fill("a long test password")
    page.locator("#login-form").get_by_role("button",name=re.compile("log in|sign in",re.I)).click()
    page.locator("#paste").wait_for(state="visible")
    read(page,"Det er lige meget.")
    assert page.locator("#session-label").is_hidden()
    assert page.locator("#change-key").is_hidden()
    assert page.locator("#login-password").input_value()==""
    assert page.evaluate("localStorage.length+sessionStorage.length")==0
    page.locator("#disconnect").click()
    page.locator("#api-key-form").wait_for(state="visible")
    assert page.locator("#reader-screen").is_hidden()
    assert page.locator("#api-key").input_value()==""
    page.reload()
    page.locator("#api-key-form").wait_for(state="visible")
    assert page.locator("#paste").input_value()==""
    assert page.evaluate("localStorage.length+sessionStorage.length")==0


def test_signup_reports_disabled_provider_before_posting_account(browser_page):
    page=browser_page
    page.route(re.compile(r"https://[^/]+\.supabase\.co/rest/v1/rpc/username_available"),lambda route:route.fulfill(json=True))
    page.route(re.compile(r"https://[^/]+\.supabase\.co/auth/v1/settings"),lambda route:route.fulfill(json={"mailer_autoconfirm":True,"external":{"email":False}}))
    page.locator('[data-auth-mode="signup"]').click()
    page.locator('#signup-email').fill('new_reader')
    page.locator('#signup-password').fill('a long test password')
    page.locator('#signup-password-confirm').fill('a long test password')
    page.locator('#signup-key').fill('gsk_test_only')
    page.locator('#signup-form button[type=submit]').click()
    page.locator('#auth-status').filter(has_text='Enable the Email provider').wait_for()
    assert page.locator('#import-screen').is_hidden()


def test_signup_requires_matching_password_confirmation(browser_page):
    page=browser_page
    page.route(re.compile(r"https://[^/]+\.supabase\.co/rest/v1/rpc/username_available"),lambda route:route.fulfill(json=True))
    page.locator('[data-auth-mode="signup"]').click()
    page.locator('#signup-email').fill('matching_reader')
    page.locator('#signup-password').fill('a long test password')
    page.locator('#signup-key').fill('gsk_test_only')
    assert not page.locator('#signup-form').evaluate('form=>form.checkValidity()')
    page.locator('#signup-password-confirm').fill('a different password')
    page.locator('#signup-form button[type=submit]').click()
    assert page.locator('#signup-password-confirm').evaluate('input=>input.validationMessage')=='Passwords do not match.'
    page.locator('#signup-password-confirm').fill('a long test password')
    assert page.locator('#signup-form').evaluate('form=>form.checkValidity()')
    page.locator('#signup-password').fill('another long password')
    assert not page.locator('#signup-form').evaluate('form=>form.checkValidity()')
    page.locator('[data-auth-mode="key"]').click()
    assert page.locator('#signup-password-confirm').input_value()==''


def test_username_availability_suggests_a_free_name_and_rejects_invalid_names(browser_page):
    page=browser_page
    candidates=[]
    def availability(route):
        candidate=route.request.post_data_json["candidate"]
        candidates.append(candidate)
        route.fulfill(json=candidate!="taken_name")
    page.route(re.compile(r"https://[^/]+\.supabase\.co/rest/v1/rpc/username_available"),availability)
    page.locator('[data-auth-mode="signup"]').click()
    page.locator("#signup-form").get_by_label("Username",exact=True).fill("taken_name")
    page.locator("#username-status").filter(has_text="Username taken").wait_for()
    suggestion=page.locator("#username-suggestion").inner_text()
    assert re.fullmatch(r"taken_name_?\d{1,3}",suggestion)
    assert suggestion in candidates
    page.screenshot(path="test-results/username-signup.png",full_page=True)
    page.locator("#username-suggestion").click()
    page.locator("#username-status").filter(has_text="Available").wait_for()
    assert page.locator("#signup-email").input_value()==suggestion
    count=len(candidates)
    page.locator("#signup-email").fill("bad name")
    page.locator("#username-status").filter(has_text="letters").wait_for()
    assert len(candidates)==count
    assert page.locator("#username-suggestion").is_hidden()
    page.locator("#signup-email").fill("open_reader")
    page.locator("#username-status").filter(has_text="Available").wait_for()
    assert candidates[-1]=="open_reader"
    assert page.locator("#username-suggestion").is_hidden()


def test_change_key_reprepares_the_document_with_the_new_memory_key(page):
    headers=[]
    def provider(route):
        headers.append(route.request.headers["authorization"])
        route.fulfill(json=prepared(route.request.post_data_json))
    page.route(GROQ,provider)
    read(page,"Det er lige meget.")
    page.locator("#change-key").evaluate("el=>el.click()")
    page.locator("#api-key-form").wait_for(state="visible")
    assert page.locator("#reader-screen").is_hidden()
    assert page.locator("#api-key").input_value()==""
    page.locator("#api-key").fill("gsk_second_browser_test")
    page.locator("#api-key-form").get_by_role("button",name="Continue",exact=True).click()
    page.locator("#reader-screen").wait_for(state="visible");ready(page)
    assert page.locator("#reader").inner_text()=="Det er lige meget."
    assert headers==["Bearer gsk_browser_test_only","Bearer gsk_second_browser_test"]


def test_change_key_returns_to_an_unstarted_preview(page):
    page.locator("#paste").fill("Det er lige meget.")
    page.locator("#prepare").click()
    page.locator("#preview-text").wait_for(state="visible")
    page.locator("#preview-text").fill("Min redigerede tekst.")
    page.locator("#change-key").evaluate("el=>el.click()")
    page.locator("#api-key").fill("gsk_preview_replacement")
    page.locator("#api-key-form").get_by_role("button",name="Continue",exact=True).click()
    page.locator("#preview-text").wait_for(state="visible")
    assert page.locator("#preview-text").input_value()=="Min redigerede tekst."
    assert page.preparations==[]
    page.locator("#start-reading").click();ready(page)
    assert page.locator("#reader").inner_text()=="Min redigerede tekst."


def test_disconnect_cancels_a_pending_login_without_restoring_account_state(page):
    pending=[]
    page.route(re.compile(r"https://[^/]+\.supabase\.co/auth/v1/token\?.*"),lambda route:pending.append(route))
    page.locator("#change-key").evaluate("el=>el.click()")
    page.locator('[data-auth-mode="login"]').click()
    page.locator("#login-email").fill("late_reader")
    page.locator("#login-password").fill("a late account password")
    with page.expect_request(re.compile(r"https://[^/]+\.supabase\.co/auth/v1/token\?.*")):
        page.locator("#login-form").get_by_role("button",name="Log in",exact=True).click()
    assert len(pending)==1
    assert page.locator("#change-key").is_hidden()
    page.locator("#disconnect").click()
    pending[0].fulfill(json={"access_token":"late-session-token","user":{
        "id":"11111111-1111-4111-8111-111111111111","email":"late_reader@usernames.danskreader.invalid","user_metadata":{},
    }})
    page.wait_for_timeout(100)
    assert page.locator("#auth-screen").is_visible()
    assert page.locator("#reader-screen").is_hidden()
    assert page.locator("#session-controls").is_hidden()
    assert page.locator("#save-key-label").is_hidden()
    for field in ["api-key","login-email","login-password","signup-password","signup-key"]:
        assert page.locator(f"#{field}").input_value()==""
    assert page.locator('[data-auth-mode="login"]').is_enabled()
    assert page.locator('[data-auth-mode="signup"]').is_enabled()
    assert page.locator("#auth-status").inner_text()==""
    page.locator("#api-key").fill("gsk_fresh_session")
    page.locator("#api-key-form").get_by_role("button",name="Continue",exact=True).click()
    page.locator("#paste").wait_for(state="visible")
    assert page.locator("#session-label").inner_text()==""
    assert page.locator("#session-label").is_hidden()
    assert page.preparations==[]


def test_change_key_cancels_a_pending_file_import_without_reopening_preview(page):
    page.evaluate("""() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function() {
        return new Promise(resolve => {
          window.releaseFileImport = async () => resolve(await original.call(this));
        });
      };
    }""")
    page.locator("#file-input").set_input_files({"name":"late.txt","mimeType":"text/plain","buffer":b"A late imported document."})
    page.wait_for_function("typeof window.releaseFileImport === 'function'")
    page.locator("#change-key").evaluate("el=>el.click()")
    page.locator("#api-key-form").wait_for(state="visible")
    page.evaluate("async () => { await window.releaseFileImport(); await new Promise(resolve => setTimeout(resolve, 0)); }")
    assert page.locator("#auth-screen").is_visible()
    assert page.locator("#preview-screen").is_hidden()
    assert page.locator("#reader-screen").is_hidden()
    assert page.locator("#preview-text").input_value()==""
    assert page.locator("#api-key").input_value()==""
    assert page.preparations==[]


def test_background_starts_without_hover_and_cached_hovers_are_instant(page):
    page.screenshot(path="test-results/import-desktop.png",full_page=True)
    read(page);count=len(page.preparations);assert count>0
    assert page.locator('.preparation-strip').is_hidden()
    word=page.locator(".word").filter(has_text="lige");word.hover()
    assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    box,target=page.locator("#tooltip").bounding_box(),word.bounding_box()
    assert box["width"]<240 and box["height"]<55 and box["y"]+box["height"]<=target["y"]
    page.locator("#reader-title").hover();word.hover()
    assert len(page.preparations)==count
    page.locator("#language").select_option("it");ready(page);word.hover()
    assert page.locator("#tooltip").inner_text()=="Non importa"
    count=len(page.preparations);page.locator("#language").select_option("en");word.hover()
    assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    assert len(page.preparations)==count
    page.reload();page.locator("#api-key-form").wait_for(state="visible")
    assert page.locator("#reader-screen").is_hidden()
    assert page.locator("#api-key").input_value()==""
    assert page.locator("#paste").input_value()==""
    assert page.evaluate("localStorage.length+sessionStorage.length")==0


def test_polish_target_is_separate_from_english_and_italian_cache(page):
    read(page,"Det er lige meget.")
    page.locator('#language').select_option('pl');ready(page)
    page.locator('.word').filter(has_text='lige').hover()
    assert page.locator('#tooltip').inner_text()=='To nie ma znaczenia'
    assert page.preparations[-1]['language']=='Polish'
    page.locator('#language').select_option('it');ready(page)
    page.locator('.word').filter(has_text='lige').hover()
    assert page.locator('#tooltip').inner_text()=='Non importa'
    count=len(page.preparations)
    page.locator('#language').select_option('pl');ready(page)
    page.locator('.word').filter(has_text='lige').hover()
    assert page.locator('#tooltip').inner_text()=='To nie ma znaczenia'
    assert len(page.preparations)==count


def test_unprepared_hover_does_not_request_and_updates_when_background_finishes(page):
    pending=[];page.route(GROQ,lambda route:pending.append(route))
    read(page,"Det er lige meget.",wait=False)
    assert page.locator('.preparation-strip').is_visible()
    word=page.locator(".word").filter(has_text="lige");word.hover()
    assert page.locator("#tooltip").is_visible()
    assert page.locator("#tooltip").inner_text()=="..."
    assert "loading" in page.locator("#tooltip").get_attribute("class")
    assert page.locator("#translation-text").evaluate("el=>getComputedStyle(el).animationName")!="none"
    assert page.locator("#lookup-status").is_hidden()
    for _ in range(3):page.locator("#reader-title").hover();word.hover()
    assert len(pending)==1
    pending[0].fulfill(json=prepared(pending[0].request.post_data_json))
    page.get_by_text("It doesn't matter",exact=True).wait_for()
    assert page.locator('.preparation-strip').is_hidden()
    assert len(pending)==1


def test_mobile_waiting_status_keeps_hover_target_in_place(page):
    page.set_viewport_size({"width":390,"height":844})
    pending=[];page.route(GROQ,lambda route:pending.append(route))
    read(page,"Det er lige meget.",wait=False)
    word=page.locator(".word").filter(has_text="lige")
    before=word.bounding_box()["y"];word.hover();page.wait_for_timeout(250)
    assert abs(word.bounding_box()["y"]-before)<2
    pending[0].fulfill(json=prepared(pending[0].request.post_data_json))
    page.get_by_text("It doesn't matter",exact=True).wait_for()


def test_preparation_finishing_after_pointer_leaves_does_not_reopen_tooltip(page):
    pending=[];page.route(GROQ,lambda route:pending.append(route))
    read(page,"Det er lige meget.",wait=False)
    page.locator(".word").filter(has_text="lige").hover()
    page.locator("#reader-title").hover()
    pending[0].fulfill(json=prepared(pending[0].request.post_data_json))
    page.wait_for_timeout(250)
    assert page.locator("#tooltip").is_hidden()


def test_document_reset_does_not_display_old_preparation(page):
    pending=[];page.route(GROQ,lambda route:pending.append(route))
    read(page,"Det er lige meget.",wait=False)
    page.locator(".word").filter(has_text="lige").hover()
    page.locator("#new-document").click()
    page.route(GROQ,lambda route:route.fulfill(json=prepared(route.request.post_data_json)))
    read(page,"En helt ny tekst.")
    pending[0].fulfill(json=prepared(pending[0].request.post_data_json,"OLD DOCUMENT ANSWER"))
    page.wait_for_timeout(50);assert page.locator("#tooltip").is_hidden()
    assert "OLD DOCUMENT ANSWER" not in page.locator("#reader").inner_text()


def test_clicking_blank_text_space_keeps_the_current_scroll_position(page):
    read(page,'\n\n'.join(f'Afsnit nummer {i}. Det er lige meget.' for i in range(40)))
    paragraph=page.locator('#reader p').nth(20)
    paragraph.scroll_into_view_if_needed()
    bounds=paragraph.bounding_box();x=bounds['x']+bounds['width']-8;y=bounds['y']+bounds['height']/2
    assert page.evaluate('([x,y])=>!document.elementFromPoint(x,y).closest(".word")',[x,y])
    before=page.evaluate('scrollY');assert before>1000
    page.mouse.click(x,y)
    assert abs(page.evaluate('scrollY')-before)<2


def test_pin_keyboard_and_safe_text(page):
    value="<img src=x onerror=alert(1)>"
    page.route(GROQ,lambda route:route.fulfill(json=prepared(route.request.post_data_json,value)))
    read(page,"<script>alert(1)</script>\n\nDet er lige meget.")
    assert page.locator("#reader script").count()==0
    word=page.locator(".word").filter(has_text="lige");word.click()
    page.get_by_text(value,exact=True).wait_for();page.locator("#reader-title").hover()
    assert page.locator("#tooltip").is_visible();assert page.locator("#tooltip img").count()==0
    page.keyboard.press("Escape");assert page.locator("#tooltip").is_hidden()
    word.focus();page.keyboard.press("ArrowRight");assert page.locator(":focus").inner_text()=="meget"
    page.keyboard.press("Enter");assert page.locator("#tooltip").is_visible()


def test_preview_upload_and_cached_selection(page):
    page.locator("#file-input").set_input_files({"name":"tekst.txt","mimeType":"text/plain","buffer":b"Wrong text."})
    page.locator("#preview-text").wait_for(state="visible");page.locator("#preview-text").fill("Det er lige meget.")
    page.locator("#start-reading").click();ready(page);count=len(page.preparations)
    select_words(page,"lige","meget")
    assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    assert len(page.preparations)==count
    page.screenshot(path="test-results/reader.png",full_page=True)


def test_docx_import_uses_local_mammoth_and_plain_text_preview(page):
    from docx import Document
    document=Document()
    document.add_paragraph("Før tabellen.")
    document.add_table(rows=1,cols=1).cell(0,0).text="I tabellen."
    document.add_paragraph("Efter tabellen.")
    output=BytesIO();document.save(output)
    page.locator("#file-input").set_input_files({"name":"tekst.docx","mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","buffer":output.getvalue()})
    page.locator("#preview-text").wait_for(state="visible")
    assert page.locator("#preview-text").input_value()=="Før tabellen.\n\nI tabellen.\n\nEfter tabellen."
    page.locator("#start-reading").click();ready(page)
    assert page.locator("#reader p").count()==3


def test_explicit_selection_gets_a_complete_meaning_and_caches_it(page):
    read(page,"Det er lige meget.");count=len(page.preparations)
    select_words(page,"Det","er",click=False)
    assert len(page.preparations)==count
    page.locator("#selection-translate").click()
    page.get_by_text("It is",exact=True).wait_for()
    assert len(page.preparations)==count+1
    assert page.preparations[-1]["target_word_ids"]==[0,1]
    page.keyboard.press("Escape")
    select_words(page,"Det","er")
    assert page.locator("#tooltip").inner_text()=="It is"
    assert len(page.preparations)==count+1


def test_full_sentence_selection_translates_together_without_changing_hover_cache(page):
    read(page,"Det er lige meget.");count=len(page.preparations)
    assert page.locator(".brand").inner_text()=="Dansk."
    assert page.locator("#reader").get_attribute("title") is None
    assert page.locator("#session-label").is_hidden()
    assert page.locator("#change-key").is_hidden()
    select_words(page,"Det","meget")
    page.get_by_text("It doesn't matter",exact=True).wait_for()
    assert len(page.preparations)==count+1
    assert page.preparations[-1]["target_word_ids"]==[0,1,2,3]
    page.screenshot(path="test-results/full-selection.png",full_page=True)
    page.keyboard.press("Escape")
    page.locator(".word").filter(has_text="Det").hover()
    assert page.locator("#tooltip").inner_text()=="Det"
    assert len(page.preparations)==count+1


def test_selection_across_paragraphs_translates_the_whole_selection_once(page):
    read(page);count=len(page.preparations)
    select_words(page,"Det","op")
    page.get_by_text("It doesn't matter. She looked up the word.",exact=True).wait_for()
    assert len(page.preparations)==count+1
    body=page.preparations[-1]
    assert body["target_word_ids"]==list(range(8))
    assert [word["text"] for word in body["words"]]==["Det","er","lige","meget","Hun","slog","ordet","op"]
    page.keyboard.press("Escape")
    select_words(page,"Det","op")
    assert page.locator("#tooltip").inner_text()=="It doesn't matter. She looked up the word."
    assert len(page.preparations)==count+1


def test_schema_rejection_recovers_in_background_before_cached_hover(page):
    calls=[]
    def provider(route):
        calls.append(route.request.post_data_json)
        if len(calls)==1:
            route.fulfill(status=400,json={"error":{"code":"json_validate_failed","type":"invalid_request_error","failed_generation":"PRIVATE FRAGMENT"}})
        else:
            route.fulfill(json=prepared(route.request.post_data_json))
    page.route(GROQ,provider)
    read(page,"Det er lige meget.")
    assert len(calls)==2
    page.locator(".word").filter(has_text="lige").hover()
    assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    assert len(calls)==2
    assert "PRIVATE FRAGMENT" not in page.locator("body").inner_text()


def test_rate_limit_pauses_background_and_hovers_cannot_retry(page):
    requests=[]
    def route(request):requests.append(request);request.fulfill(status=429,headers={"Retry-After":"12"},json={"error":{"message":"Provider text must not be shown."}})
    page.route(GROQ,route);read(page,wait=False)
    page.locator("#preparation-status").filter(has_text="usage limit").wait_for()
    page.locator(".word").nth(2).hover();page.locator(".word").nth(1).click()
    assert len(requests)==1;assert page.locator("#tooltip").inner_text()=="..."
    page.locator("#retry-preparation").click();assert len(requests)==1
    assert "Wait" in page.locator("#preparation-status").inner_text()
    assert page.locator("#reader").is_visible()


def test_scroll_prioritizes_the_top_visible_chunk_after_the_active_request(page):
    pending=[];seen=[]
    def provider(route):
        body=json.loads(route.request.post_data_json['messages'][1]['content']);seen.append(body)
        if len(seen)==1:pending.append(route)
        else:route.fulfill(json=prepared(body))
    page.route(GROQ,provider)
    read(page,' '.join(f'ord{i}' for i in range(300)),wait=False)
    page.locator('#reader .word').nth(190).evaluate('word=>scrollTo(0,word.getBoundingClientRect().top+scrollY)')
    page.wait_for_timeout(250)
    first_visible=page.locator('#reader .word').evaluate_all('words=>words.find(word=>word.getBoundingClientRect().bottom>0).textContent')
    pending[0].fulfill(json=prepared(pending[0].request.post_data_json))
    ready(page)
    assert len(seen)>1
    next_targets={word['text'] for word in seen[1]['words'] if word['id'] in seen[1]['target_word_ids']}
    assert first_visible in next_targets


def test_long_context_unicode_and_new_document(page):
    read(page,"😀 "+"ord "*600+"Åse så en ø.")
    count=len(page.preparations);page.locator(".word").filter(has_text="Åse").click()
    assert page.locator("#tooltip").inner_text()=="Åse"
    assert all(len(body["context"])<=2000 for body in page.preparations)
    assert len(page.preparations)==count
    page.locator("#new-document").click();assert page.locator("#reader-screen").is_hidden()


def test_mobile_layout_and_spaced_blank_paragraphs(page):
    page.set_viewport_size({"width":390,"height":844});page.screenshot(path="test-results/import-mobile.png",full_page=True)
    read(page,"Hej.\n\n \n\nFarvel.");page.locator(".word").filter(has_text="Farvel").click()
    assert page.locator("#tooltip").inner_text()=="Goodbye"
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")


def layout_pdf(lower_first=False):
    from pypdf import PdfReader,PdfWriter
    from pypdf.generic import DecodedStreamObject,NameObject
    from test_documents import pdf_bytes
    writer=PdfWriter();writer.append(PdfReader(BytesIO(pdf_bytes(["First page","Hun slog ordet op."]))))
    stream=DecodedStreamObject();stream.set_data("q 0.9 0.95 0.88 rg 30 660 540 120 re f Q\nBT /F1 24 Tf 40 750 Td (En dansk historie) Tj ET\nBT /F1 12 Tf 40 700 Td (Det er lige meget.) Tj ET\nBT /F1 12 Tf 330 700 Td (Højre kolonne.) Tj ET\nBT /F1 12 Tf 40 682 Td (Jeg har god tid.) Tj ET\nBT /F1 12 Tf 330 682 Td (En anden historie.) Tj ET".encode("cp1252"))
    if lower_first:
        lines=stream.get_data().splitlines()
        stream.set_data(b'\n'.join([lines[0],lines[2],lines[1],*lines[3:]]))
    writer.pages[0][NameObject("/Contents")]=writer._add_object(stream);writer.pages[1].rotate(90)
    out=BytesIO();writer.write(out);return out.getvalue()


def upload_pdf(page,data,wait=True):
    page.locator("#file-input").set_input_files({"name":"historie.pdf","mimeType":"application/pdf","buffer":data})
    page.locator(".pdf-page .word").first.wait_for()
    if wait:ready(page)


def test_original_pdf_hover_zoom_pages_and_view_switch(page):
    upload_pdf(page,layout_pdf());assert page.locator("#reading-mode").input_value()=="pdf"
    assert page.locator("#document-meta").inner_text()=="historie.pdf"
    assert page.locator("#preview-screen").is_hidden()
    word=page.locator(".pdf-page .word").filter(has_text="lige");word.hover()
    assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    body=next(body for body in page.preparations if "lige" in body["context"])
    assert "Det er lige meget.\nJeg har god tid." in body["context"].split('\n\n')
    page.screenshot(path="test-results/pdf-reader.png",full_page=True);count=len(page.preparations)
    page.locator("#pdf-zoom").select_option("1.5")
    page.wait_for_function("()=>document.querySelector('.pdf-page')?.clientWidth===900")
    page.locator(".pdf-page .word").filter(has_text="lige").click()
    assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    assert len(page.preparations)==count
    page.locator("#pdf-next").click();page.locator(".pdf-page .word").filter(has_text="Hun").wait_for()
    assert page.locator("#pdf-page").input_value()=="2"
    page.locator(".pdf-page .word").filter(has_text="slog").hover()
    assert page.locator("#tooltip").inner_text()=="looked up"
    page.locator("#reading-mode").select_option("text");page.locator("#reader p").first.wait_for();ready(page)
    page.locator("#reading-mode").select_option("pdf");page.locator(".pdf-page canvas").wait_for()
    page.locator("#new-document").click();read(page,"Ny tekst.")
    assert page.locator(".pdf-page").count()==0;assert page.locator("#reading-mode").is_hidden()


def test_pdf_preparation_starts_visually_at_top_despite_content_stream_order(page):
    seen=[]
    def provider(route):
        body=json.loads(route.request.post_data_json['messages'][1]['content']);seen.append(body)
        route.fulfill(json=prepared(body))
    page.route(GROQ,provider)
    upload_pdf(page,layout_pdf(lower_first=True))
    assert seen[0]['context'].startswith('En dansk historie')


def test_pdf_current_page_prioritizes_background_preparation(page):
    pending=[];seen=[]
    def route(request):
        body=json.loads(request.request.post_data_json["messages"][1]["content"]);seen.append(body)
        if len(seen)==1:pending.append(request)
        else:request.fulfill(json=prepared(body))
    page.route(GROQ,route);upload_pdf(page,layout_pdf(),wait=False)
    page.locator("#pdf-next").click();page.locator(".pdf-page .word").filter(has_text="Hun").wait_for()
    pending[0].fulfill(json=prepared(pending[0].request.post_data_json));ready(page)
    assert "Hun slog" in seen[1]["context"]


def test_scanned_pdf_still_displays_original_page(page):
    from test_documents import pdf_bytes
    page.locator("#file-input").set_input_files({"name":"scan.pdf","mimeType":"application/pdf","buffer":pdf_bytes([None])})
    page.locator(".pdf-page canvas").wait_for()
    assert "No readable text" in page.locator("#app-status").inner_text();assert page.locator(".pdf-page .word").count()==0


def test_pdf_fit_width_resize_and_phrase_selection(page):
    upload_pdf(page,layout_pdf());page.set_viewport_size({"width":390,"height":844})
    page.wait_for_function("()=>document.querySelector('.pdf-page').clientWidth<=document.getElementById('reader-paper').clientWidth")
    select_words(page,"lige","meget");assert page.locator("#tooltip").inner_text()=="It doesn't matter"
    page.screenshot(path="test-results/pdf-mobile.png",full_page=True)


def test_pdf_text_edits_survive_view_switching(page):
    upload_pdf(page,layout_pdf());page.locator("#reading-mode").select_option("text");page.locator("#edit-document").click()
    page.locator("#preview-text").fill("Min rettede tekst.");page.locator("#start-reading").click()
    page.get_by_text("Min rettede tekst.",exact=True).wait_for();ready(page)
    page.locator("#reading-mode").select_option("pdf");page.locator(".pdf-page canvas").wait_for()
    page.locator("#reading-mode").select_option("text");page.get_by_text("Min rettede tekst.",exact=True).wait_for()


def test_pdf_mode_switch_hides_navigation_and_keeps_import_local(page):
    upload_pdf(page,layout_pdf());page.locator("#reading-mode").select_option("text")
    page.locator("#reader p").first.wait_for()
    assert page.locator("#pdf-controls").is_hidden()


def test_pdf_horizontal_scroll_keeps_tooltip_above_its_word(page):
    page.set_viewport_size({"width":700,"height":900});upload_pdf(page,layout_pdf())
    page.locator("#pdf-zoom").select_option("2");page.wait_for_function("()=>document.querySelector('.pdf-page').clientWidth===1200")
    page.locator("#reader-paper").evaluate("el=>el.scrollLeft=100")
    page.locator(".pdf-page .word").filter(has_text="lige").click();assert page.locator("#tooltip").is_visible()
    before=page.locator("#tooltip").bounding_box()["x"]
    page.locator("#reader-paper").evaluate("el=>el.scrollLeft-=40");page.wait_for_timeout(100)
    assert abs(page.locator("#tooltip").bounding_box()["x"]-before-40)<2
