#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑苹果星球 自动登录 + 自动搜索（调试版）
打印详细信息，帮助定位问题
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.keys import Keys
import time
import os

# ===== 配置区 =====
USERNAME = "fjdcml@126.com"
PASSWORD = "Cml366119"
SEARCH_KEYWORD = "音乐播放软件"
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

        # ===== 1. 打开首页 =====
        print("🌐 打开黑苹果星球首页: https://heipg.cn")
        driver.get("https://heipg.cn")
        time.sleep(2)

        # ===== 2. 点击登录按钮 =====
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

        time.sleep(2)

        # ===== 3. 填写账号密码 =====
        print("\n📧 填写登录表单...")

        # 打印所有输入框
        all_inputs = driver.find_elements(By.TAG_NAME, "input")
        print(f"\n🔍 页面共找到 {len(all_inputs)} 个输入框：")
        for i, inp in enumerate(all_inputs):
            try:
                print(f"  [{i}] type={inp.get_attribute('type')}, name={inp.get_attribute('name')}, id={inp.get_attribute('id')}, placeholder={inp.get_attribute('placeholder')}")
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

        time.sleep(0.5)

        # ===== 4. 点击【安全登录】 =====
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
            print(f"\n🔍 页面共找到 {len(all_btns)} 个按钮：")
            for i, btn in enumerate(all_btns):
                try:
                    print(f"  [{i}] text='{btn.text}', class='{btn.get_attribute('class')}', id='{btn.get_attribute('id')}'")
                except:
                    pass
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
            print("⚠️ 未找到提交按钮")

        # ===== 5. 等待登录完成 =====
        print("\n⏳ 等待5秒让登录完成...")
        time.sleep(5)

        # 检查登录状态
        page_source = driver.page_source
        if "logout" in page_source.lower() or "退出" in page_source:
            print("✅ 登录成功！")
        else:
            print("⚠️ 登录状态未知，继续尝试搜索...")

        # ===== 6. 搜索 =====
        print(f"\n🔍 搜索关键词: {SEARCH_KEYWORD}")

        # 打印页面上所有输入框（找搜索框）
        all_inputs_after = driver.find_elements(By.TAG_NAME, "input")
        print(f"\n🔍 登录后页面共找到 {len(all_inputs_after)} 个输入框：")
        for i, inp in enumerate(all_inputs_after):
            try:
                print(f"  [{i}] type={inp.get_attribute('type')}, name={inp.get_attribute('name')}, id={inp.get_attribute('id')}, placeholder={inp.get_attribute('placeholder')}")
            except:
                pass

        # 查找搜索框
        search_input = None
        search_selectors = [
            (By.CSS_SELECTOR, "input[name='s']"),
            (By.CSS_SELECTOR, "input[type='search']"),
            (By.CSS_SELECTOR, ".search-input"),
            (By.CSS_SELECTOR, "input[placeholder*='搜索']"),
            (By.XPATH, "//input[@type='text' and @placeholder]"),
        ]

        for by, selector in search_selectors:
            try:
                search_input = driver.find_element(by, selector)
                if search_input.is_displayed():
                    print(f"   ✅ 通过选择器找到搜索框: {selector}")
                    break
            except:
                continue

        if not search_input:
            # 尝试用通用方式
            try:
                search_input = driver.find_element(By.TAG_NAME, "input")
                print(f"   ✅ 通过通用方式找到输入框: {search_input.get_attribute('placeholder')}")
            except:
                pass

        if search_input:
            print(f"   🔍 搜索框属性: name={search_input.get_attribute('name')}, id={search_input.get_attribute('id')}, placeholder={search_input.get_attribute('placeholder')}")
            search_input.clear()
            search_input.send_keys(SEARCH_KEYWORD)
            print("   ✅ 已输入关键词")
            
            # 尝试多种方式提交
            search_input.submit()
            print("   ✅ 已提交搜索")
        else:
            print("❌ 未找到搜索框")

        time.sleep(3)

        # ===== 完成 =====
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
