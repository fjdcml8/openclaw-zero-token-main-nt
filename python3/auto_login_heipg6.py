#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑苹果星球 (https://heipg.cn) 自动登录脚本 v6
强化点击登录按钮，更可靠的定位方式
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, NoSuchElementException
import time
import os

# ===== 配置区 =====
USERNAME = "fjdcml@126.com"
PASSWORD = "Cml366119"
CHROME_DRIVER_PATH = "/usr/local/bin/chromedriver"
# =================


def login_heipg():
    driver = None
    try:
        if not os.path.exists(CHROME_DRIVER_PATH):
            print(f"❌ 找不到 ChromeDriver: {CHROME_DRIVER_PATH}")
            return

        print("🚀 启动 Chrome 浏览器...")
        service = Service(executable_path=CHROME_DRIVER_PATH)
        options = Options()
        options.add_argument("--start-maximized")
        driver = webdriver.Chrome(service=service, options=options)
        wait = WebDriverWait(driver, 10)

        # 1. 打开首页
        print("🌐 打开黑苹果星球首页: https://heipg.cn")
        driver.get("https://heipg.cn")
        time.sleep(2)

        # 2. 点击登录按钮
        print("📡 点击登录按钮...")
        login_btn = None
        
        # 方式1: 通过文本查找
        try:
            login_btn = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//*[contains(text(), '登录')]"))
            )
            print("   ✅ 通过文本找到登录按钮")
        except:
            pass

        if not login_btn:
            try:
                login_btn = wait.until(
                    EC.element_to_be_clickable((By.PARTIAL_LINK_TEXT, "登录"))
                )
                print("   ✅ 通过部分链接文本找到登录按钮")
            except:
                pass

        if not login_btn:
            try:
                login_btn = wait.until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, ".login, .login-btn, .header-login, .top-login"))
                )
                print("   ✅ 通过CSS选择器找到登录按钮")
            except:
                pass

        if login_btn:
            driver.execute_script("arguments[0].click();", login_btn)
            print("✅ 已点击登录按钮")
        else:
            print("⚠️ 所有方式都找不到登录按钮，请手动点击")
            input("   点击后按 Enter 继续...")

        time.sleep(1.5)

        # 3. 填写账号密码
        print("\n📧 查找并填写登录表单...")

        # 尝试切换到 iframe
        try:
            iframes = driver.find_elements(By.TAG_NAME, "iframe")
            if iframes:
                for iframe in iframes:
                    driver.switch_to.frame(iframe)
                    if driver.find_elements(By.NAME, "username"):
                        print("   ✅ 切换到登录 iframe")
                        break
                    driver.switch_to.default_content()
        except:
            pass

        # 填写用户名
        username_input = None
        for selector in ["username", "user_login", "log", "user"]:
            try:
                username_input = driver.find_element(By.NAME, selector)
                print(f"   ✅ 通过 NAME='{selector}' 找到用户名输入框")
                break
            except:
                pass
        if not username_input:
            try:
                username_input = driver.find_element(By.ID, "user_login")
                print("   ✅ 通过 ID='user_login' 找到用户名输入框")
            except:
                pass
        if not username_input:
            try:
                username_input = driver.find_element(By.ID, "username")
                print("   ✅ 通过 ID='username' 找到用户名输入框")
            except:
                pass

        if username_input:
            username_input.clear()
            username_input.send_keys(USERNAME)
            print("✅ 已填写账号")
        else:
            print("⚠️ 未找到用户名输入框，请手动填写")

        # 填写密码
        password_input = None
        for selector in ["password", "user_pass", "pwd"]:
            try:
                password_input = driver.find_element(By.NAME, selector)
                print(f"   ✅ 通过 NAME='{selector}' 找到密码输入框")
                break
            except:
                pass
        if not password_input:
            try:
                password_input = driver.find_element(By.ID, "user_pass")
                print("   ✅ 通过 ID='user_pass' 找到密码输入框")
            except:
                pass
        if not password_input:
            try:
                password_input = driver.find_element(By.ID, "password")
                print("   ✅ 通过 ID='password' 找到密码输入框")
            except:
                pass

        if password_input:
            password_input.clear()
            password_input.send_keys(PASSWORD)
            print("✅ 已填写密码")
        else:
            print("⚠️ 未找到密码输入框，请手动填写")

        # 4. 验证码（手动输入）
        print("\n" + "=" * 50)
        print("🔐 请在浏览器中查看验证码图片")
        print("   然后回到终端输入验证码")
        print("=" * 50)
        captcha = input("请输入验证码: ").strip()

        if captcha:
            # 查找验证码输入框
            captcha_input = None
            for selector in ["captcha_code", "captcha", "verification", "code"]:
                try:
                    captcha_input = driver.find_element(By.NAME, selector)
                    break
                except:
                    pass
            if not captcha_input:
                try:
                    captcha_input = driver.find_element(By.ID, "captcha_code")
                except:
                    pass
            if not captcha_input:
                try:
                    captcha_input = driver.find_element(By.ID, "captcha")
                except:
                    pass

            if captcha_input:
                captcha_input.clear()
                captcha_input.send_keys(captcha)
                print("✅ 验证码已填写")
            else:
                print("⚠️ 未找到验证码输入框，请手动填写")
                input("   填写后按 Enter 继续...")
        else:
            print("⚠️ 未输入验证码，尝试继续...")

        # =========================================================
        # 5. ⭐ 强化点击登录提交按钮
        # =========================================================
        print("\n✅ 开始查找并点击登录提交按钮...")
        submit_btn = None
        
        # 先打印页面上所有按钮，帮助调试
        print("   🔍 页面上所有 button 元素：")
        all_buttons = driver.find_elements(By.TAG_NAME, "button")
        for i, btn in enumerate(all_buttons):
            try:
                text = btn.text or btn.get_attribute("value") or ""
                class_name = btn.get_attribute("class") or ""
                btn_id = btn.get_attribute("id") or ""
                btn_type = btn.get_attribute("type") or ""
                print(f"      [{i}] text='{text[:30]}', class='{class_name[:30]}', id='{btn_id}', type='{btn_type}'")
            except:
                pass
        
        # 方式1: 通过文本"安全登录"或"登录"查找按钮
        try:
            submit_btn = driver.find_element(By.XPATH, "//button[contains(text(), '安全登录')]")
            if submit_btn:
                print("   ✅ 通过文本'安全登录'找到按钮")
        except:
            pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.XPATH, "//button[contains(text(), '登录')]")
                if submit_btn:
                    print("   ✅ 通过文本'登录'找到按钮")
            except:
                pass
        
        # 方式2: 通过 type='submit'
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.XPATH, "//button[@type='submit']")
                if submit_btn:
                    print("   ✅ 通过 button[@type='submit'] 找到按钮")
            except:
                pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.XPATH, "//input[@type='submit']")
                if submit_btn:
                    print("   ✅ 通过 input[@type='submit'] 找到按钮")
            except:
                pass
        
        # 方式3: 通过 class 包含 login 或 submit
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.CSS_SELECTOR, "[class*='login'], [class*='submit']")
                if submit_btn:
                    print(f"   ✅ 通过 class 包含 login/submit 找到按钮")
            except:
                pass
        
        # 方式4: 通过 id 包含 login 或 submit
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.CSS_SELECTOR, "[id*='login'], [id*='submit']")
                if submit_btn:
                    print(f"   ✅ 通过 id 包含 login/submit 找到按钮")
            except:
                pass
        
        # 方式5: 遍历所有 button，找文本包含登录的
        if not submit_btn:
            all_btns = driver.find_elements(By.TAG_NAME, "button")
            for btn in all_btns:
                try:
                    text = btn.text or ""
                    if "登录" in text or "安全登录" in text:
                        submit_btn = btn
                        print(f"   ✅ 遍历找到文本包含'登录'的按钮: '{text}'")
                        break
                except:
                    pass
        
        # 方式6: 按回车键提交（备用）
        if submit_btn:
            print("\n   🖱️ 使用 JavaScript 点击提交按钮...")
            driver.execute_script("arguments[0].click();", submit_btn)
            print("✅ 已自动点击登录提交按钮！")
        else:
            print("\n⚠️ 未找到提交按钮，尝试按回车键提交...")
            try:
                # 在密码框按回车
                password_input.send_keys("\n")
                print("✅ 已按回车键提交")
            except:
                print("⚠️ 回车提交失败，请手动点击登录")
                input("   点击后按 Enter 继续...")

        # 等待登录完成
        print("\n⏳ 等待登录完成...")
        time.sleep(3)

        # 检查登录是否成功
        current_url = driver.current_url
        page_source = driver.page_source

        if "logout" in page_source.lower() or "退出" in page_source:
            print("🎉 登录成功！")
        else:
            print(f"⚠️ 当前页面: {current_url}")
            print("   请手动确认是否登录成功")

        print("\n⏳ 浏览器将在 30 秒后关闭...")
        time.sleep(30)

    except Exception as e:
        print(f"❌ 发生错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            driver.quit()
            print("👋 浏览器已关闭")


if __name__ == "__main__":
    login_heipg()
