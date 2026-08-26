#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑苹果星球 (https://heipg.cn) 自动登录脚本

脚本自动打开首页、点击登录按钮、填写账号密码和验证码，
验证码部分需要你手动输入，输入后自动点击登录。
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
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
                    EC.element_to_be_clickable((By.LINK_TEXT, "登录"))
                )
                print("   ✅ 通过链接文本找到登录按钮")
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

        time.sleep(1)

        # 3. 查找并填写登录表单
        print("📧 查找登录表单...")

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
        print("📧 填写用户名...")
        username_input = None
        for selector in ["username", "user_login", "log"]:
            try:
                username_input = driver.find_element(By.NAME, selector)
                break
            except:
                pass
        if not username_input:
            try:
                username_input = driver.find_element(By.ID, "user_login")
            except:
                pass

        if username_input:
            username_input.clear()
            username_input.send_keys(USERNAME)
            print("✅ 已填写账号")
        else:
            print("⚠️ 未找到用户名输入框，请手动填写")

        # 填写密码
        print("🔑 填写密码...")
        password_input = None
        for selector in ["password", "user_pass"]:
            try:
                password_input = driver.find_element(By.NAME, selector)
                break
            except:
                pass
        if not password_input:
            try:
                password_input = driver.find_element(By.ID, "user_pass")
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
            for selector in ["captcha_code", "captcha", "verification"]:
                try:
                    captcha_input = driver.find_element(By.ID, selector)
                    break
                except:
                    pass
            if not captcha_input:
                try:
                    captcha_input = driver.find_element(By.NAME, "captcha")
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

        # 5. ⭐ 自动点击登录提交按钮（关键步骤）
        print("✅ 自动点击登录提交按钮...")
        submit_btn = None
        
        # 尝试多种方式找到提交按钮
        for selector in ["wp-submit", "submit", "login", "log-in"]:
            try:
                submit_btn = driver.find_element(By.NAME, selector)
                if submit_btn:
                    print(f"   ✅ 通过 NAME='{selector}' 找到提交按钮")
                    break
            except:
                pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.ID, "wp-submit")
                if submit_btn:
                    print("   ✅ 通过 ID='wp-submit' 找到提交按钮")
            except:
                pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.ID, "submit")
                if submit_btn:
                    print("   ✅ 通过 ID='submit' 找到提交按钮")
            except:
                pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.XPATH, "//button[@type='submit']")
                if submit_btn:
                    print("   ✅ 通过 button[@type='submit'] 找到提交按钮")
            except:
                pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.XPATH, "//input[@type='submit']")
                if submit_btn:
                    print("   ✅ 通过 input[@type='submit'] 找到提交按钮")
            except:
                pass
        
        if not submit_btn:
            try:
                submit_btn = driver.find_element(By.XPATH, "//*[contains(text(), '登录') and (@type='submit' or @class='button')]")
                if submit_btn:
                    print("   ✅ 通过文本和属性找到提交按钮")
            except:
                pass

        if submit_btn:
            # 使用 JavaScript 点击，更可靠
            driver.execute_script("arguments[0].click();", submit_btn)
            print("✅ 已自动点击登录提交按钮！")
        else:
            print("⚠️ 未找到提交按钮，请手动点击登录")
            input("   点击后按 Enter 继续...")

        # 等待登录完成
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
    finally:
        if driver:
            driver.quit()
            print("👋 浏览器已关闭")


if __name__ == "__main__":
    login_heipg()
