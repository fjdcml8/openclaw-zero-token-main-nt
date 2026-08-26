#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动登录 126 邮箱
使用 Selenium 控制 Chrome 浏览器（驱动位于用户主目录）
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
import time
import getpass
import os

# ===== 配置区 =====
USERNAME = "fjdcml"
PASSWORD = "Cml-366119"
HEADLESS = False

# 指定用户主目录下的 ChromeDriver 路径
CHROME_DRIVER_PATH = os.path.expanduser("~/chromedriver")
# =================


def login_126():
    """自动登录 126 邮箱"""
    
    # 检查驱动文件是否存在
    if not os.path.exists(CHROME_DRIVER_PATH):
        print(f"❌ 错误：找不到 ChromeDriver 文件！")
        print(f"请确保文件存在于：{CHROME_DRIVER_PATH}")
        print("\n你可以通过以下方式安装：")
        print("1. 使用 Homebrew: brew install chromedriver")
        print("2. 或从官方下载: https://storage.googleapis.com/chrome-for-testing-public/150.0.7871.125/mac-x64/chromedriver-mac-x64.zip")
        print("   下载后解压并移动到 ~/chromedriver")
        return
    
    # 给驱动文件添加执行权限（如果需要）
    os.chmod(CHROME_DRIVER_PATH, 0o755)
    
    # Chrome 选项配置
    chrome_options = Options()
    if HEADLESS:
        chrome_options.add_argument("--headless")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    
    # 创建 Service 对象，指定 ChromeDriver 路径
    service = Service(executable_path=CHROME_DRIVER_PATH)
    driver = webdriver.Chrome(service=service, options=chrome_options)
    
    try:
        print("🚀 正在打开 126 邮箱登录页面...")
        driver.get("https://mail.126.com/")
        
        # 等待页面加载完成
        wait = WebDriverWait(driver, 10)
        
        # 切换到登录 iframe
        print("📡 切换到登录框...")
        iframe = wait.until(EC.presence_of_element_located((By.XPATH, "//iframe[contains(@src, '126.com')]")))
        driver.switch_to.frame(iframe)
        
        # 输入账号
        print("📧 输入账号...")
        username_input = wait.until(EC.presence_of_element_located((By.NAME, "email")))
        username_input.clear()
        username_input.send_keys(USERNAME)
        
        # 输入密码
        print("🔑 输入密码...")
        password_input = driver.find_element(By.NAME, "password")
        password_input.clear()
        password_input.send_keys(PASSWORD)
        
        # 点击登录按钮
        print("✅ 点击登录...")
        login_btn = driver.find_element(By.ID, "dologin")
        login_btn.click()
        
        # 等待跳转
        time.sleep(3)
        
        # 切换回主页面
        driver.switch_to.default_content()
        
        # 检查登录是否成功
        current_url = driver.current_url
        if "mail.126.com" in current_url and "login" not in current_url:
            print("🎉 登录成功！")
            print(f"📌 当前页面：{current_url}")
        else:
            print("❌ 登录可能失败，请检查账号密码是否正确")
            print(f"📌 当前 URL：{current_url}")
        
        print("⏳ 浏览器将在 30 秒后关闭...")
        time.sleep(30)
        
    except Exception as e:
        print(f"❌ 发生错误：{e}")
        
    finally:
        driver.quit()
        print("👋 浏览器已关闭")


def main():
    global USERNAME, PASSWORD
    if not USERNAME:
        USERNAME = input("请输入 126 邮箱账号（不含 @126.com）：")
    if not PASSWORD:
        PASSWORD = getpass.getpass("请输入密码（输入时不可见）：")
    login_126()


if __name__ == "__main__":
    main()
