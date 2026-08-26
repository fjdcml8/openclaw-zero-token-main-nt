#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑苹果星球 自动登录 + 自动搜索迅雷
全自动完成：登录 → 搜索迅雷
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
SEARCH_KEYWORD = "迅雷"
CHROME_DRIVER_PATH = "/usr/local/bin/chromedriver"
# =================


def login_and_search():
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

        print("🌐 打开黑苹果星球首页: https://heipg.cn")
        driver.get("https://heipg.cn")
        time.sleep(2)

        # 点击登录按钮
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
                    EC.element_to_be_clickable((By.PARTIAL_LINK_TEXT, "登录"))
                )
                print("   ✅ 通过部分链接文本找到登录按钮")
            except:
                pass

        if login_btn:
            driver.execute_script("arguments[0].click();", login_btn)
            print("✅ 已点击登录按钮")
        else:
            print("⚠️ 找不到登录按钮，请手动点击")
            input("   点击后按 Enter 继续...")

        time.sleep(1.5)

        # 填写账号密码
        print("\n📧 填写登录表单...")

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

        if username_input:
            username_input.clear()
            username_input.send_keys(USERNAME)
            print("✅ 已填写账号")
        else:
            print("⚠️ 未找到用户名输入框，请手动填写")

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

        if password_input:
            password_input.clear()
            password_input.send_keys(PASSWORD)
            print("✅ 已填写密码")
        else:
            print("⚠️ 未找到密码输入框，请手动填写")

        time.sleep(0.5)

        # 点击安全登录
        print("\n🔓 点击【安全登录】按钮...")
        submit_btn = None

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

        if not submit_btn:
            all_btns = driver.find_elements(By.TAG_NAME, "button")
            for btn in all_btns:
                try:
                    text = btn.text or ""
                    if "登录" in text or "安全登录" in text:
                        submit_btn = btn
                        print(f"   ✅ 遍历找到按钮: '{text}'")
                        break
                except:
                    pass

        if submit_btn:
            driver.execute_script("arguments[0].click();", submit_btn)
            print("✅ 已点击【安全登录】按钮！")
        else:
            print("⚠️ 未找到提交按钮，尝试按回车键提交...")
            try:
                password_input.send_keys("\n")
                print("✅ 已按回车键提交")
            except:
                print("⚠️ 回车提交失败，请手动点击登录")
                input("   点击后按 Enter 继续...")

        print("\n⏳ 等待登录完成...")
        time.sleep(4)

        # 搜索迅雷
        print(f"\n🔍 搜索关键词: {SEARCH_KEYWORD}")

        search_input = None
        search_selectors = [
            (By.CSS_SELECTOR, "input[name='s']"),
            (By.CSS_SELECTOR, "input[type='search']"),
            (By.CSS_SELECTOR, ".search-input"),
            (By.CSS_SELECTOR, "input[placeholder*='搜索']"),
        ]

        for by, selector in search_selectors:
            try:
                search_input = WebDriverWait(driver, 5).until(
                    EC.presence_of_element_located((by, selector))
                )
                if search_input.is_displayed():
                    print(f"   ✅ 找到搜索框")
                    break
            except:
                continue

        if not search_input:
            try:
                search_icon = driver.find_element(By.CSS_SELECTOR, ".search-btn, .icon-search")
                search_icon.click()
                time.sleep(1)
                search_input = driver.find_element(By.CSS_SELECTOR, "input[type='text']")
                print("   ✅ 点击搜索图标后找到搜索框")
            except:
                pass

        if search_input:
            search_input.clear()
            search_input.send_keys(SEARCH_KEYWORD)
            search_input.submit()
            print(f"✅ 已搜索: {SEARCH_KEYWORD}")
        else:
            print("⚠️ 未找到搜索框，请手动搜索")

        time.sleep(2)

        print(f"\n✅ 完成！当前URL: {driver.current_url}")
        print("📌 浏览器保持打开，按 Ctrl+C 可终止")

        while True:
            time.sleep(60)

    except KeyboardInterrupt:
        print("\n⏹️ 已终止")
        return True
    except Exception as e:
        print(f"❌ 发生错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            driver.quit()
            print("👋 浏览器已关闭")


if __name__ == "__main__":
    login_and_search()
