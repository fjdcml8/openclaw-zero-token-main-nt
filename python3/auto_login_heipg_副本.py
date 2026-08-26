#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑苹果星球 - 自动登录脚本（PyAutoGUI 版）
使用鼠标坐标直接点击登录按钮
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.action_chains import ActionChains
import time
import os
import pyautogui

# ===== 配置区 =====
USERNAME = "fjdcml@126.com"
PASSWORD = "Cml366119"
CHROME_DRIVER_PATH = "/usr/local/bin/chromedriver"
# =================

# PyAutoGUI 安全设置
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.2


def get_mouse_position():
    """获取当前鼠标位置（用于调试）"""
    x, y = pyautogui.position()
    print(f"   📍 当前鼠标位置: ({x}, {y})")
    return x, y


def click_at_position(x, y, clicks=1):
    """在指定位置点击"""
    try:
        pyautogui.moveTo(x, y, duration=0.3)
        time.sleep(0.2)
        pyautogui.click(clicks=clicks)
        print(f"   🖱️ 点击位置: ({x}, {y})")
        return True
    except Exception as e:
        print(f"   ❌ 点击失败: {e}")
        return False


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
        print("\n🌐 打开黑苹果星球首页: https://heipg.cn")
        driver.get("https://heipg.cn")
        time.sleep(2)

        # 2. 点击登录按钮（使用 Selenium）
        print("\n📡 点击登录按钮...")
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

        if login_btn:
            driver.execute_script("arguments[0].click();", login_btn)
            print("✅ 已点击登录按钮")
        else:
            print("⚠️ 找不到登录按钮，请手动点击")
            input("   点击后按 Enter 继续...")

        time.sleep(2)

        # 3. 填写账号和密码
        print("\n📧 填写账号密码...")

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
            print("⚠️ 未找到用户名输入框")

        # 填写密码
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
            print("⚠️ 未找到密码输入框")

        # ===== 4. 使用 PyAutoGUI 点击登录按钮 =====
        print("\n" + "=" * 50)
        print("🖱️ 准备用鼠标点击登录按钮")
        print("=" * 50)
        print("\n⏳ 请在 5 秒内将鼠标移动到【登录】按钮上")
        print("   不要点击，只是把鼠标移过去")
        
        # 倒计时
        for i in range(5, 0, -1):
            print(f"   {i}...")
            time.sleep(1)
        
        # 获取鼠标当前位置
        x, y = pyautogui.position()
        print(f"\n📍 鼠标位置: ({x}, {y})")
        print("   将在该位置点击登录")
        
        # 点击
        if click_at_position(x, y):
            print("✅ 已点击登录按钮！")
        else:
            print("❌ 点击失败，请手动点击")
            input("   点击后按 Enter 继续...")

        # 等待登录完成
        print("\n⏳ 等待登录结果...")
        time.sleep(4)

        # 检查登录是否成功
        page_source = driver.page_source
        if "退出" in page_source or "logout" in page_source.lower():
            print("\n🎉 登录成功！")
        elif "用户中心" in page_source:
            print("\n🎉 登录成功！")
        else:
            print("\n⚠️ 请检查浏览器窗口确认登录状态")

        print("\n⏳ 浏览器将在 30 秒后关闭...")
        time.sleep(30)

    except Exception as e:
        print(f"\n❌ 发生错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            driver.quit()
            print("\n👋 浏览器已关闭")


if __name__ == "__main__":
    # 确保 pyautogui 已安装
    try:
        import pyautogui
    except ImportError:
        print("❌ pyautogui 未安装，请运行: pip3 install pyautogui")
        exit(1)
    login_heipg()
